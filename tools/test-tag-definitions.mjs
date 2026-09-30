#!/usr/bin/env node
// Run only against a disposable gateway on port 5091. Dummy connection fixtures remain in that isolated store.
// Usage: node tools/test-tag-definitions.mjs [http://127.0.0.1:5091] [--capacity]
import assert from 'node:assert/strict';

const args = process.argv.slice(2);
assert.ok(args.every(arg => !arg.startsWith('--') || arg === '--capacity'), 'Only --capacity is supported.');
const urls = args.filter(arg => !arg.startsWith('--'));
assert.ok(urls.length <= 1);
const base = new URL(urls[0] ?? 'http://127.0.0.1:5091');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname));
assert.equal(base.protocol, 'http:');
assert.equal(base.port, '5091', 'Tag tests may run only on isolated port 5091.');
assert.equal(base.pathname, '/');
assert.ok(!base.username && !base.password && !base.search && !base.hash);
const prefix = `[default]TagTests/Run${Date.now()}`;
const created = new Set();
const results = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function request(route, method = 'GET', body, status = 200) {
  const response = await fetch(new URL(route, base), {
    method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000), redirect: 'error',
  });
  const raw = await response.text();
  assert.equal(response.status, status, `${method} ${route}: expected ${status}, got ${response.status}: ${raw.slice(0, 500)}`);
  return { data: raw ? JSON.parse(raw) : null, raw };
}
const definitions = async () => (await request('/api/tag-definitions')).data;
async function save(definition) {
  const result = await request('/api/tags', 'POST', definition);
  created.add(result.data.path);
  return result.data;
}
function memory(name, dataType = 'Double', value = 1) {
  return { path: `${prefix}/${name}`, kind: 'memory', dataType, value };
}
async function reject(definition) {
  const before = await definitions();
  await request('/api/tags', 'POST', definition, 400);
  assert.deepEqual(await definitions(), before, 'A rejected configuration changed tag definitions.');
}
async function remove(path, expected = 204) {
  await request(`/api/tag-definitions?path=${encodeURIComponent(path)}`, 'DELETE', undefined, expected);
  created.delete(path);
}
async function script(code) {
  const { data } = await request('/api/scripts/run', 'POST', { code });
  assert.equal(data.success, true, JSON.stringify(data));
  return data.result;
}
async function test(name, action) {
  try { await action(); results.push(true); console.log(`PASS ${name}`); }
  catch (error) { results.push(false); console.error(`FAIL ${name}: ${error.stack ?? error}`); }
}
function rawNumber(definition, number) {
  return JSON.stringify({ ...definition, value: '__NUMBER__' }).replace('"__NUMBER__"', number);
}

console.log(`Testing tag definitions at ${base.origin}; fixture namespace ${prefix}`);
try {
  await test('all seven memory datatypes save with explicit canonical defaults', async () => {
    for (const [type, value] of [['Boolean', true], ['Int16', -32768], ['Int32', -2147483648], ['Int64', 9007199254740991], ['Float', 1.25], ['Double', -1.25], ['String', 'local value']]) {
      const saved = await save(memory(type, type, value));
      assert.equal(saved.kind, 'memory'); assert.equal(saved.dataType, type); assert.equal(saved.value, value);
      assert.equal(saved.enabled, true); assert.equal(saved.publishingIntervalMs, 1000);
      assert.ok(!('connectionId' in saved) && !('nodeId' in saved));
    }
  });

  await test('upsert changes a tag at the same path without adding another definition', async () => {
    const before = await definitions();
    await save(memory('Double', 'Double', 9.5));
    const after = await definitions();
    assert.equal(after.length, before.length);
    assert.equal(after.find(tag => tag.path === `${prefix}/Double`).value, 9.5);
  });

  await test('Int64 bounds and integral JSON decimals/exponents retain exact integer values', async () => {
    for (const number of ['9223372036854775807', '-9223372036854775808', '1.000', '100e-2']) {
      const definition = memory('ExactInteger', 'Int64', 0);
      const { data, raw } = await request('/api/tags', 'POST', rawNumber(definition, number));
      created.add(data.path);
      const expected = number.includes('.') || number.includes('e') ? '1' : number;
      assert.match(raw, new RegExp(`"value"\\s*:\\s*${expected}(?=,|})`));
    }
  });

  await test('integer overflow, fractions and tiny residual fractions are rejected', async () => {
    for (const [type, number] of [['Int16', '32768'], ['Int16', '-32769'], ['Int32', '2147483648'], ['Int32', '-2147483649'], ['Int64', '9223372036854775808'], ['Int64', '-9223372036854775809'], ['Int64', '1.5'], ['Int64', '1.000000000000000000000000000001'], ['Int64', '1e-100'], ['Int64', '1e1000']])
      await reject(rawNumber(memory('RejectedInteger', type, 0), number));
  });

  await test('numeric types reject nonfinite values and Float overflow', async () => {
    await reject(rawNumber(memory('OverflowDouble', 'Double', 0), '1e400'));
    await reject(rawNumber(memory('OverflowFloat', 'Float', 0), '3.5e38'));
    await reject(rawNumber(memory('OverflowFloat', 'Float', 0), '-3.5e38'));
  });

  await test('datatype, kind and scalar value mismatches are rejected', async () => {
    for (const definition of [memory('BadType', 'Decimal', 1), memory('BadBoolean', 'Boolean', 'true'), memory('BadString', 'String', 1), memory('BadNumber', 'Double', '1'), memory('Null', 'Double', null), memory('Array', 'String', []), { path: `${prefix}/MissingType`, kind: 'memory', value: 1 }, { path: `${prefix}/MissingValue`, kind: 'memory', dataType: 'Double' }, { ...memory('BadKind'), kind: 'calculated' }])
      await reject(definition);
  });

  await test('invalid, indirect and reserved paths cannot be configured', async () => {
    for (const path of ['', '[other]Tag', '[default]', '[default]/Tag', '[default]A/', '[default]A//B', '[default]A/./B', '[default]A/../B', '[default]A/ /B', '[default]A\nB', '[default]A[B]', '[default]A{line}', '[default]A\\B', '[default]Line/Custom', '[default]Setpoints/Custom', '[default]Line', `[default]${'x'.repeat(504)}`])
      await reject({ ...memory('InvalidPath'), path });
  });

  await test('enabled and publishing interval fields validate types and bounds', async () => {
    for (const enabled of [null, 'true', 1]) await reject({ ...memory('BadEnabled'), enabled });
    for (const publishingIntervalMs of [null, '1000', true, 99, 60001, 100.5]) await reject({ ...memory('BadInterval'), publishingIntervalMs });
    for (const publishingIntervalMs of [100, 60000]) {
      const saved = await save({ ...memory(`Interval${publishingIntervalMs}`), publishingIntervalMs });
      assert.equal(saved.publishingIntervalMs, publishingIntervalMs);
    }
  });

  let opcId;
  await test('legacy OPC definitions retain kind and interval defaults; connection and node IDs validate', async () => {
    const fixture = `tag-tests-${Date.now()}`;
    opcId = `${fixture}-opc`;
    await request('/api/connections', 'POST', { id: opcId, name: 'Isolated tag-test OPC fixture', type: 'opcua', endpoint: 'opc.tcp://127.0.0.1:49999' });
    const sqlId = `${fixture}-sql`;
    await request('/api/connections', 'POST', { id: sqlId, name: 'Isolated tag-test SQL fixture', type: 'sqlserver', server: '127.0.0.1', database: 'TagTests' });
    const legacy = { path: `${prefix}/LegacyOpc`, connectionId: opcId, nodeId: 'ns=2;s=Example.Tag', enabled: false };
    const saved = await save(legacy);
    assert.equal(saved.kind, 'opcua'); assert.equal(saved.publishingIntervalMs, 1000); assert.equal(saved.enabled, false);
    assert.equal(saved.nodeId, legacy.nodeId);
    await reject({ ...legacy, connectionId: 'does-not-exist' });
    await reject({ ...legacy, connectionId: sqlId });
    await reject({ ...legacy, nodeId: 'ns=not-an-integer;i=42' });
    await reject({ ...legacy, nodeId: '' });
    await reject({ ...legacy, dataType: 'Unknown' });
  });

  await test('Python writes configured memory tags and the saved value is readable immediately', async () => {
    const definition = await save(memory('Writable', 'Int32', 10));
    const result = await script(`path = ${JSON.stringify(definition.path)}\nquality = system.tag.writeBlocking([path], [42])[0]\nresult = {"quality": str(quality), "value": system.tag.readBlocking([path])[0].value}`);
    assert.deepEqual(result, { quality: 'Good', value: 42 });
    assert.equal((await definitions()).find(tag => tag.path === definition.path).value, 42);
    const invalid = await script(`result = str(system.tag.writeBlocking([${JSON.stringify(definition.path)}], [1.5])[0])`);
    assert.ok(invalid.startsWith('Bad'));
    assert.equal((await definitions()).find(tag => tag.path === definition.path).value, 42);
  });

  await test('disabled memory and OPC tags reject Python writes without changing configuration', async () => {
    const disabled = await save({ ...memory('Disabled', 'Double', 5), enabled: false });
    for (const path of [disabled.path, `${prefix}/LegacyOpc`]) {
      const result = await script(`result = str(system.tag.writeBlocking([${JSON.stringify(path)}], [99])[0])`);
      assert.ok(result.startsWith('Bad'), `Write unexpectedly succeeded: ${path}`);
    }
    assert.equal((await definitions()).find(tag => tag.path === disabled.path).value, 5);
  });

  await test('deletion removes the definition and its runtime value; missing paths return 404', async () => {
    const tag = await save(memory('DeleteMe', 'Double', 123));
    const initialized = await script(`path = ${JSON.stringify(tag.path)}\nsystem.tag.writeBlocking([path], [456])\nresult = system.tag.readBlocking([path])[0].value`);
    assert.equal(initialized, 456, 'The value must exist in the runtime cache before deletion.');
    await remove(tag.path);
    await remove(tag.path, 404);
    assert.ok(!(await definitions()).some(definition => definition.path === tag.path));
    let quality;
    for (let attempt = 0; attempt < 30; attempt++) {
      quality = (await request('/api/tags/read', 'POST', { paths: [tag.path] })).data[0].quality;
      if (quality === 'Bad_NotFound') break;
      await wait(100);
    }
    assert.equal(quality, 'Bad_NotFound');
  });

  if (args.includes('--capacity')) {
    await test('10,000 configured tags are allowed; 10,001 fail and upserts still work', async () => {
      const current = await definitions();
      const maximum = 10_000;
      assert.ok(current.length <= maximum);
      const oversized = { format: 'sparkstudio.tags', version: 1, tags: Array.from({ length: maximum + 1 }, (_, index) => memory(`RejectedCapacity${index}`, 'Boolean', false)) };
      await request('/api/tag-engineering/preview', 'POST', oversized, 400);
      assert.deepEqual(await definitions(), current, 'An over-limit import preview changed tag definitions.');
      const additions = Array.from({ length: maximum - current.length }, (_, index) => memory(`Capacity${index}`, 'Boolean', false));
      // One reviewed transaction avoids 10,000 whole-configuration saves in a capacity check.
      if (additions.length) {
        const package_ = { format: 'sparkstudio.tags', version: 1, tags: additions };
        const { data: preview } = await request('/api/tag-engineering/preview', 'POST', package_);
        assert.equal(preview.canApply, true);
        for (const tag of additions) created.add(tag.path);
        await request('/api/tag-engineering/apply', 'POST', { package: package_, revision: preview.revision, previewToken: preview.previewToken });
      }
      assert.equal((await definitions()).length, maximum);
      await reject(memory('OverCapacity'));
      await save(memory('Double', 'Double', 10));
      assert.equal((await definitions()).length, maximum);
    });
  }
} finally {
  await test('remove only tag fixtures created by this run', async () => {
    if (args.includes('--capacity')) {
      const removeTags = (await definitions()).filter(tag => created.has(tag.path) && tag.path.startsWith(prefix + '/')).map(tag => tag.path);
      if (removeTags.length) {
        const package_ = { format: 'sparkstudio.tags', version: 2, tags: [], udtDefinitions: [], instances: [], scanGroups: [], removeTags };
        const { data: preview } = await request('/api/tag-engineering/preview', 'POST', package_);
        assert.equal(preview.canApply, true);
        await request('/api/tag-engineering/apply', 'POST', { package: package_, revision: preview.revision, previewToken: preview.previewToken });
      }
    } else for (const path of [...created]) await remove(path);
    assert.ok(!(await definitions()).some(definition => definition.path.startsWith(prefix + '/')));
  });
}
console.log(`\n${results.filter(Boolean).length}/${results.length} tag-definition checks passed. ${args.includes('--capacity') ? 'Capacity boundary included.' : 'Capacity boundary skipped; use --capacity.'} Dummy OPC/SQL connection fixtures remain only in the isolated test store.`);
process.exitCode = results.every(Boolean) ? 0 : 1;
