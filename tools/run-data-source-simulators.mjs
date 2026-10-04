#!/usr/bin/env node
// Independently authored loopback workshop fixtures, not a production agent or broker.
import http from 'node:http';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import { unsProbe, unsCurrent } from './uns-model-fixture.mjs';

const envelope = result => ({ success: true, result });
const mqttString = text => { const bytes = Buffer.from(text); const prefix = Buffer.alloc(2); prefix.writeUInt16BE(bytes.length); return Buffer.concat([prefix, bytes]); };
const variableLength = value => { const bytes = []; do { let byte = value % 128; value = Math.floor(value / 128); if (value) byte |= 128; bytes.push(byte); } while (value); return Buffer.from(bytes); };
const packet = (header, body) => Buffer.concat([Buffer.from([header]), variableLength(body.length), body]);
function remaining(buffer, offset) {
  let number = 0, multiplier = 1;
  for (let index = offset; index < offset + 4; index++) {
    if (index >= buffer.length) return null;
    const byte = buffer[index]; number += (byte & 127) * multiplier;
    if (!(byte & 128)) return { number, end: index + 1 };
    multiplier *= 128;
  }
  throw new Error('Invalid fixture MQTT remaining length.');
}
function stringAt(buffer, offset) {
  if (offset + 2 > buffer.length) throw new Error('Truncated fixture MQTT string.');
  const size = buffer.readUInt16BE(offset);
  if (offset + 2 + size > buffer.length) throw new Error('Truncated fixture MQTT string.');
  return { text: buffer.subarray(offset + 2, offset + 2 + size).toString('utf8'), end: offset + 2 + size };
}
function matches(filter, topic) {
  if (topic.startsWith('$') && !filter.startsWith('$')) return false;
  const levels = filter.split('/'), names = topic.split('/');
  for (let index = 0; index < levels.length; index++) {
    if (levels[index] === '#') return index === levels.length - 1;
    if (names[index] === undefined || levels[index] !== '+' && levels[index] !== names[index]) return false;
  }
  return levels.length === names.length;
}
function serialize(value) {
  return JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? '__exact_fixture_' + item : item).replace(/"__exact_fixture_(-?\d+)"/g, '$1');
}
async function readJson(request) {
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > 64 * 1024) throw new Error('Fixture request exceeds 64 KiB.'); chunks.push(chunk); }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

export async function startDataSourceSimulators({ mtPort = 5310, i3xPort = 5311, mqttPort = 18890, unsModels = false } = {}) {
  let tick = 1, closing = false, clientCounter = 0;
  const stride = unsModels ? 8 : 3;
  const started = new Date().toISOString(), paused = new Set(), subscriptions = new Map(), clients = new Set(), streams = new Set();
  const stats = { mtRequests: 0, i3xRequests: 0, mqttConnections: 0, mqttSubscriptions: 0, mqttPublishAttempts: 0 };
  const sourceValues = () => ({
    'workshop:temperature#1': { value: 20 + tick / 10, quality: 'Good', timestamp: new Date().toISOString() },
    'workshop:count#1': { value: 9007199254740993n + BigInt(tick), quality: 'Good', timestamp: new Date().toISOString() },
    'workshop:state#1': { value: { running: tick % 10 < 8, description: 'Synthetic cell' }, quality: 'Good', timestamp: new Date().toISOString() },
  });
  const header = streams => `<Header creationTime="${new Date().toISOString()}" sender="SparkStudio synthetic fixture" instanceId="1" version="2.8.0" bufferSize="300" deviceModelChangeTime="${started}"${streams ? ` firstSequence="${Math.max(1, tick * stride - 296)}" lastSequence="${tick * stride + stride}" nextSequence="${tick * stride + stride + 1}"` : ''}/>`;
  const probe = () => `<?xml version="1.0"?><MTConnectDevices xmlns="urn:mtconnect.org:MTConnectDevices:2.8">${header(false)}<Devices><Device id="cnc" name="Synthetic CNC" uuid="workshop-cnc"><Components><Controller id="controller" name="Controller"><DataItems><DataItem id="speed" name="Speed" category="SAMPLE" type="ROTARY_VELOCITY" units="REVOLUTION/MINUTE"/><DataItem id="count" name="PartCount" category="EVENT" type="PART_COUNT"/><DataItem id="condition" name="System" category="CONDITION" type="SYSTEM"/></DataItems></Controller></Components></Device><Agent id="agent" name="Agent" uuid="workshop-agent"><DataItems><DataItem id="availability" name="Availability" category="EVENT" type="AVAILABILITY"/></DataItems></Agent></Devices></MTConnectDevices>`;
  function current(from = 0) {
    if (unsModels) return unsCurrent(header(true), tick, from);
    const at = new Date().toISOString(), sequence = tick * 3 + 1;
    const sample = sequence >= from ? `<RotaryVelocity dataItemId="speed" timestamp="${at}" sequence="${sequence}">${100 + tick}</RotaryVelocity>` : '';
    const event = sequence + 1 >= from ? `<PartCount dataItemId="count" timestamp="${at}" sequence="${sequence + 1}">${9007199254740993n + BigInt(tick)}</PartCount>` : '';
    const condition = sequence + 2 >= from ? tick % 10 < 3 ? `<Fault dataItemId="condition" timestamp="${at}" sequence="${sequence + 2}" conditionId="fixture-fault" nativeCode="DEMO">Synthetic condition</Fault>` : `<Normal dataItemId="condition" timestamp="${at}" sequence="${sequence + 2}">Normal</Normal>` : '';
    return `<?xml version="1.0"?><MTConnectStreams xmlns="urn:mtconnect.org:MTConnectStreams:2.8">${header(true)}<Streams><DeviceStream name="Synthetic CNC" uuid="workshop-cnc"><ComponentStream component="Controller" componentId="controller"><Samples>${sample}</Samples><Events>${event}</Events><Condition>${condition}</Condition></ComponentStream></DeviceStream></Streams></MTConnectStreams>`;
  }
  const error = () => `<?xml version="1.0"?><MTConnectError xmlns="urn:mtconnect.org:MTConnectError:2.8">${header(false)}<Errors><Error errorCode="OUT_OF_RANGE">Fixture cursor expired</Error></Errors></MTConnectError>`;
  const sendJson = (response, value, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(serialize(value)); };
  const mt = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname === '/fixture/control' && request.method === 'POST') {
        const body = await readJson(request);
        for (const name of ['mtconnect', 'i3x', 'mqtt']) { if (body.paused?.includes(name)) paused.add(name); else paused.delete(name); }
        return sendJson(response, { paused: [...paused] });
      }
      if (url.pathname === '/fixture/state') return sendJson(response, { tick, paused: [...paused], ...stats });
      stats.mtRequests++;
      if (paused.has('mtconnect')) { response.writeHead(503); return response.end('Synthetic source paused.'); }
      if (url.pathname.endsWith('/probe')) { response.writeHead(200, { 'content-type': 'application/xml' }); return response.end(unsModels ? unsProbe(header(false)) : probe()); }
      if (url.pathname.endsWith('/current')) { response.writeHead(200, { 'content-type': 'application/xml' }); return response.end(current()); }
      if (url.pathname.endsWith('/sample')) {
        const from = Number(url.searchParams.get('from') ?? 0);
        if (from && from < Math.max(1, tick * stride - 296)) { response.writeHead(404, { 'content-type': 'application/xml' }); return response.end(error()); }
        response.writeHead(200, { 'content-type': 'multipart/x-mixed-replace; boundary=synthetic-mtconnect', 'cache-control': 'no-store' });
        const stream = { response, from }; streams.add(stream); request.on('close', () => streams.delete(stream));
        return;
      }
      response.writeHead(404); response.end();
    } catch { if (!response.headersSent) response.writeHead(400); response.end(); }
  });
  const i3x = http.createServer(async (request, response) => {
    try {
      stats.i3xRequests++;
      if (paused.has('i3x')) return sendJson(response, { success: false }, 503);
      const path = new URL(request.url, 'http://127.0.0.1').pathname, body = await readJson(request);
      if (path === '/v1/info') return sendJson(response, { specVersion: '1.0', serverVersion: 'independent-workshop-1', capabilities: { subscribe: { stream: false } } });
      if (path === '/v1/objecttypes') return sendJson(response, envelope([{ elementId: 'cell', schema: { type: 'string' } }, { elementId: 'temperature', schema: { type: 'number' } }, { elementId: 'count', schema: { type: 'integer' } }, { elementId: 'state', schema: { type: 'object', properties: { running: { type: 'boolean' }, description: { type: 'string' } } } }]));
      if (path === '/v1/objects') return sendJson(response, envelope([{ elementId: 'workshop:cell', displayName: 'Synthetic cell', parentId: '', typeElementId: 'cell', isComposition: true }, ...[['temperature', 'Temperature'], ['count', 'Part count'], ['state', 'State']].map(([name, displayName]) => ({ elementId: 'workshop:' + name + '#1', displayName, parentId: 'workshop:cell', typeElementId: name, isComposition: false }))]));
      if (path === '/v1/objects/value') { const values = sourceValues(); return sendJson(response, { success: true, results: (body.elementIds ?? []).map(elementId => ({ elementId, success: true, result: values[elementId] ?? { value: 'Synthetic cell', quality: 'Good', timestamp: new Date().toISOString() } })) }); }
      if (path === '/v1/subscriptions' && request.method === 'POST') { const subscriptionId = 'workshop-sub-' + ++clientCounter; if (subscriptions.size >= 100) return sendJson(response, { success: false }, 429); subscriptions.set(subscriptionId, new Set()); return sendJson(response, envelope({ subscriptionId })); }
      if (path === '/v1/subscriptions' && request.method === 'DELETE') { for (const id of body.subscriptionIds ?? []) subscriptions.delete(id); return sendJson(response, { success: true, results: (body.subscriptionIds ?? []).map(subscriptionId => ({ subscriptionId, success: true, result: null })) }); }
      const registered = subscriptions.get(body.subscriptionId);
      if (!registered) return sendJson(response, { success: false }, 404);
      if (path === '/v1/subscriptions/register' || path === '/v1/subscriptions/unregister') { for (const id of body.elementIds ?? []) if (path.endsWith('/unregister')) registered.delete(id); else registered.add(id); return sendJson(response, { success: true, results: (body.elementIds ?? []).map(elementId => ({ elementId, success: true, result: null })) }); }
      if (path === '/v1/subscriptions/sync') { const sequenceNumber = tick, values = sourceValues(); return sendJson(response, envelope(body.lastSequenceNumber >= sequenceNumber ? [] : [{ sequenceNumber, updates: [...registered].map(elementId => ({ elementId, ...(values[elementId] ?? { value: 'Synthetic cell', quality: 'Good', timestamp: new Date().toISOString() }) })) }])); }
      return sendJson(response, { success: false }, path.endsWith('/stream') ? 501 : 404);
    } catch { sendJson(response, { success: false }, 400); }
  });
  function sendTopics(client, retained = false) {
    if (paused.has('mqtt')) return;
    const values = [ ['workshop/review/temperature', String(20 + tick / 10)], ['workshop/review/count', String(9007199254740993n + BigInt(tick))], ['workshop/tree/a/b', String(tick)], ['workshop/tree/a/b/c', String(tick + 1)], ['workshop/tree/a/b/value', String(tick + 2)], ['workshop/script/cell', serialize({ value: 9007199254740993n + BigInt(tick), temperature: 20 + tick / 10, running: true, timestamp: new Date().toISOString() })] ];
    if (unsModels) values.push(['uns/Haas01/temperature', String(22 + tick / 10)], ['uns/Haas02/temperature', String(25 + tick / 10)]);
    for (const [topic, payload] of values) {
      if (!client.filters.some(filter => matches(filter, topic))) continue;
      if (client.socket.writableLength > 1024 * 1024) { client.socket.destroy(); return; }
      const body = Buffer.concat([mqttString(topic), ...(client.version === 5 ? [Buffer.from([0])] : []), Buffer.from(payload)]);
      client.socket.write(packet(retained ? 0x31 : 0x30, body));
    }
  }
  const mqtt = net.createServer(socket => {
    const client = { socket, filters: [], version: 4, buffer: Buffer.alloc(0), connected: false };
    clients.add(client); socket.on('close', () => clients.delete(client)); socket.on('error', () => {});
    socket.on('data', chunk => {
      try {
        if (client.buffer.length + chunk.length > 272 * 1024) throw new Error('Fixture packet limit.');
        client.buffer = Buffer.concat([client.buffer, chunk]);
        while (client.buffer.length > 1) {
          const length = remaining(client.buffer, 1); if (!length) return;
          if (length.number > 272 * 1024) throw new Error('Fixture packet limit.');
          if (client.buffer.length < length.end + length.number) return;
          const type = client.buffer[0] >> 4, body = client.buffer.subarray(length.end, length.end + length.number); client.buffer = client.buffer.subarray(length.end + length.number);
          if (type === 1) { const protocol = stringAt(body, 0); client.version = body[protocol.end]; if (protocol.text !== 'MQTT' || ![4, 5].includes(client.version)) throw new Error('Fixture protocol.'); client.connected = true; stats.mqttConnections++; socket.write(packet(0x20, Buffer.from(client.version === 5 ? [0, 0, 0] : [0, 0]))); }
          else if (!client.connected) throw new Error('Fixture requires CONNECT.');
          else if (type === 8) {
            let offset = 2; const reasons = [];
            if (client.version === 5) { const properties = remaining(body, offset); if (!properties) throw new Error('Fixture properties.'); offset = properties.end + properties.number; }
            while (offset < body.length) { const filter = stringAt(body, offset); offset = filter.end + 1; if (client.filters.length >= 100) throw new Error('Fixture subscription limit.'); client.filters.push(filter.text); reasons.push(0); stats.mqttSubscriptions++; }
            socket.write(packet(0x90, Buffer.concat([body.subarray(0, 2), ...(client.version === 5 ? [Buffer.from([0])] : []), Buffer.from(reasons)]))); sendTopics(client, true);
          } else if (type === 10) { let offset = client.version === 5 ? 3 : 2; while (offset < body.length) { const filter = stringAt(body, offset); client.filters = client.filters.filter(value => value !== filter.text); offset = filter.end; } socket.write(packet(0xb0, Buffer.concat([body.subarray(0, 2), ...(client.version === 5 ? [Buffer.from([0, 0])] : [])]))); }
          else if (type === 12) socket.write(packet(0xd0, Buffer.alloc(0)));
          else if (type === 14) socket.end();
          else if (type === 3) { stats.mqttPublishAttempts++; throw new Error('Workshop subscribers must never publish.'); }
          else throw new Error('Unsupported workshop packet.');
        }
      } catch { socket.destroy(); }
    });
  });
  const listening = (server, port) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  try { await listening(mt, mtPort); await listening(i3x, i3xPort); await listening(mqtt, mqttPort); }
  catch (error) { mt.close(); i3x.close(); mqtt.close(); throw error; }
  const timer = setInterval(() => {
    tick++;
    for (const stream of streams) {
      if (paused.has('mtconnect')) continue;
      if (stream.response.writableLength > 1024 * 1024) { stream.response.destroy(); streams.delete(stream); continue; }
      const document = current(stream.from); stream.from = tick * stride + stride + 1;
      stream.response.write(`--synthetic-mtconnect\r\nContent-Type: application/xml\r\nContent-Length: ${Buffer.byteLength(document)}\r\n\r\n${document}\r\n`);
    }
    for (const client of clients) if (client.connected) sendTopics(client);
  }, 1000);
  return {
    endpoints: { mtconnect: `http://127.0.0.1:${mt.address().port}`, i3x: `http://127.0.0.1:${i3x.address().port}/v1`, mqtt: `mqtt://127.0.0.1:${mqtt.address().port}` },
    async close() { if (closing) return; closing = true; clearInterval(timer); for (const client of clients) client.socket.destroy(); for (const stream of streams) stream.response.destroy(); mt.closeAllConnections(); i3x.closeAllConnections(); await Promise.all([mt, i3x, mqtt].map(server => new Promise(resolve => server.close(resolve)))); },
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length > 3 || process.argv[2] && process.argv[2] !== '--uns') throw new Error('Usage: node tools/run-data-source-simulators.mjs [--uns]');
  const fixtures = await startDataSourceSimulators({ unsModels: process.argv[2] === '--uns' });
  console.log(JSON.stringify({ synthetic: true, endpoints: fixtures.endpoints }, null, 2));
  console.log('Ctrl+C stops the loopback fixtures. They contain synthetic values only; they are not production protocol servers.');
  process.once('SIGINT', async () => { await fixtures.close(); process.exit(0); });
  process.once('SIGTERM', async () => { await fixtures.close(); process.exit(0); });
}
