#!/usr/bin/env node
// Offline authored-content and real loopback fixture checks; no gateway configuration changes.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import { startDataSourceSimulators } from './run-data-source-simulators.mjs';

let passed = 0;
const check = async (name, run) => { await run(); passed++; console.log(`PASS ${name}`); };
const example = JSON.parse(await readFile(new URL('../examples/data-sources.json', import.meta.url), 'utf8'));
const catalog = JSON.parse(await readFile(new URL('../examples/catalog.json', import.meta.url), 'utf8'));
await check('workshop is setup-required and contains no source writes or automatic project actions', () => {
  const entry = catalog.workshops.find(item => item.id === 'data-sources'); assert.ok(entry);
  assert.equal(entry.distribution, 'setup-required'); assert.equal(entry.gatewayWrites, 'none'); assert.equal(entry.entryScreenId, example.navigation.startupScreenId);
  assert.equal(example.scripts, undefined); assert.equal(example.commands, undefined); assert.equal(example.tags, undefined);
  assert.ok(example.screens.every(screen => screen.components.every(component => ['label', 'value'].includes(component.type))));
});
await check('all source recipes are read-only and MQTT starts review discovery without saved tags', () => {
  assert.deepEqual(example.sourceRecipes.map(item => item.type).sort(), ['i3x', 'mqtt', 'mtconnect']);
  for (const recipe of example.sourceRecipes) assert.ok((recipe.source.points ?? []).every(point => point.writable === false));
  const mqtt = example.sourceRecipes.find(item => item.type === 'mqtt'); assert.deepEqual(mqtt.source.points, []);
  assert.ok(mqtt.source.mqtt.mappings.every(mapping => mapping.tags === 'review'));
  assert.equal(mqtt.source.mqtt.mappings.find(mapping => mapping.id === 'script').dataType, 'Int64');
  assert.match(example.scriptTest.payload, /9007199254740993/);
});
await check('own topic value and the literal value child bind to separate original paths', () => {
  const components = example.screens[0].components;
  assert.equal(components.find(item => item.id === 'mqtt-own-value').props.tagPath, '[default]SourceWorkshop/MQTT/Tree/a/b');
  assert.equal(components.find(item => item.id === 'mqtt-real-value-child').props.tagPath, '[default]SourceWorkshop/MQTT/Tree/a/b/value');
});
const fixtures = await startDataSourceSimulators({ mtPort: 0, i3xPort: 0, mqttPort: 0 });
try {
  await check('MTConnect probe/current use namespace-qualified independent synthetic identities and exact Int64 text', async () => {
    const probe = await (await fetch(fixtures.endpoints.mtconnect + '/probe')).text();
    assert.match(probe, /urn:mtconnect.org:MTConnectDevices:2.8/); assert.match(probe, /uuid="workshop-cnc"/); assert.match(probe, /uuid="workshop-agent"/);
    const current = await (await fetch(fixtures.endpoints.mtconnect + '/current')).text(); assert.match(current, /urn:mtconnect.org:MTConnectStreams:2.8/); assert.match(current, /900719925474099\d/);
    const next = /nextSequence="(\d+)"/.exec(current)[1], last = /lastSequence="(\d+)"/.exec(current)[1]; assert.equal(Number(next), Number(last) + 1);
  });
  await check('MTConnect sample sends actual HTTP multipart documents with the advancing header cursor', async () => {
    const controller = new AbortController(); const response = await fetch(fixtures.endpoints.mtconnect + '/sample?from=7&heartbeat=1000', { signal: controller.signal });
    assert.match(response.headers.get('content-type'), /multipart\/x-mixed-replace/);
    const reader = response.body.getReader(); const first = await reader.read(); controller.abort(); await reader.cancel().catch(() => {});
    const chunk = Buffer.from(first.value).toString(); assert.match(chunk, /--synthetic-mtconnect\r\n/); assert.match(chunk, /MTConnectStreams/); assert.match(chunk, /nextSequence="\d+"/);
  });
  await check('i3X fixture reports 1.0, browses schema metadata and bulk-reads raw opaque IDs without lossy integers', async () => {
    const info = await (await fetch(fixtures.endpoints.i3x + '/info')).json(); assert.equal(info.specVersion, '1.0'); assert.equal(info.capabilities.subscribe.stream, false);
    const objects = await (await fetch(fixtures.endpoints.i3x + '/objects?includeMetadata=true')).json(); assert.ok(objects.result.some(item => item.elementId === 'workshop:count#1'));
    const types = await (await fetch(fixtures.endpoints.i3x + '/objecttypes')).json(); assert.equal(types.result.find(item => item.elementId === 'state').schema.properties.running.type, 'boolean');
    const read = await fetch(fixtures.endpoints.i3x + '/objects/value', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ elementIds: ['workshop:count#1'], maxDepth: 1 }) });
    const text = await read.text(); assert.match(text, /"value":900719925474099\d/); assert.match(text, /"elementId":"workshop:count#1"/);
  });
  await check('i3X subscription fixture supports creation, registration, sequence acknowledgment and deletion', async () => {
    const post = async (path, body, method = 'POST') => (await fetch(fixtures.endpoints.i3x + path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
    const created = await post('/subscriptions', { clientId: 'independent-workshop-test' }), subscriptionId = created.result.subscriptionId;
    const registration = await post('/subscriptions/register', { subscriptionId, elementIds: ['workshop:temperature#1'], maxDepth: 1 }); assert.equal(registration.results[0].success, true);
    const first = await post('/subscriptions/sync', { subscriptionId }); assert.equal(first.result[0].updates[0].elementId, 'workshop:temperature#1');
    const empty = await post('/subscriptions/sync', { subscriptionId, lastSequenceNumber: first.result[0].sequenceNumber }); assert.deepEqual(empty.result, []);
    const deleted = await post('/subscriptions', { subscriptionIds: [subscriptionId] }, 'DELETE'); assert.equal(deleted.results[0].success, true);
  });
  await check('MQTT5 fixture replays retained exact topics including own value, child and literal value', async () => {
    const endpoint = new URL(fixtures.endpoints.mqtt), socket = net.connect(Number(endpoint.port), '127.0.0.1');
    const done = new Promise((resolve, reject) => {
      const topics = new Set(); let buffer = Buffer.alloc(0), subscribed = false;
      const deadline = setTimeout(() => { socket.destroy(); reject(new Error('Fixture MQTT replay timed out.')); }, 3000);
      socket.on('error', reject);
      socket.on('connect', () => socket.write(Buffer.from([0x10, 16, 0, 4, 0x4d, 0x51, 0x54, 0x54, 5, 2, 0, 30, 0, 0, 3, 0x75, 0x69, 0x31])));
      socket.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length > 1) {
          let size = 0, multiplier = 1, offset = 1;
          while (offset < buffer.length) { const byte = buffer[offset++]; size += (byte & 127) * multiplier; if (!(byte & 128)) break; multiplier *= 128; }
          if (buffer.length < offset + size) return;
          const header = buffer[0], body = buffer.subarray(offset, offset + size); buffer = buffer.subarray(offset + size);
          if (header >> 4 === 2 && !subscribed) { subscribed = true; const filter = Buffer.from('workshop/tree/#'); socket.write(Buffer.concat([Buffer.from([0x82, filter.length + 6, 0, 1, 0, 0, filter.length]), filter, Buffer.from([0])])); }
          if (header >> 4 === 3) { assert.equal(header & 1, 1); const length = body.readUInt16BE(); topics.add(body.subarray(2, 2 + length).toString()); }
          if (topics.size === 3) { clearTimeout(deadline); socket.end(Buffer.from([0xe0, 0])); resolve(topics); }
        }
      });
    });
    assert.deepEqual([...await done].sort(), ['workshop/tree/a/b', 'workshop/tree/a/b/c', 'workshop/tree/a/b/value']);
  });
  await check('fixture publication pause affects only the selected synthetic source and source subscribers never publish', async () => {
    const response = await fetch(fixtures.endpoints.mtconnect + '/fixture/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"paused":["mqtt"]}' }); assert.deepEqual((await response.json()).paused, ['mqtt']);
    const state = await (await fetch(fixtures.endpoints.mtconnect + '/fixture/state')).json(); assert.equal(state.mqttPublishAttempts, 0); assert.equal(state.mqttSubscriptions, 1);
    assert.equal((await fetch(fixtures.endpoints.i3x + '/info')).status, 200);
  });
} finally { await fixtures.close(); }
console.log(`${passed} data sources workshop checks passed.`);
