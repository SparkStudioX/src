#!/usr/bin/env node
// Opt-in synthetic load only; never included in the normal test-all run.
// node tools/test-load-runtime.mjs http://127.0.0.1:5093 .data/load-fixture --seconds=30 --clients=1,10,50,100 --tags=10000 --batch-size=1000
// Before starting a NEW gateway on this directory, create load-fixture.json:
// {"kind":"sparkstudio-synthetic-load","version":1,"baseUrl":"http://127.0.0.1:5093","syntheticOnly":true}
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setMaxListeners } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

const [baseArg, directoryArg, ...options] = process.argv.slice(2);
assert.ok(baseArg && directoryArg, 'Pass the exact isolated gateway URL and its fresh data directory.');
const base = new URL(baseArg), directory = path.resolve(directoryArg), dataRoot = await realpath('.data');
const comparablePath = value => process.platform === 'win32' ? value.toLowerCase() : value;
assert.ok(base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname) && ['5091', '5093'].includes(base.port));
assert.ok(base.pathname === '/' && !base.search && !base.hash && !base.username && !base.password);
assert.ok(comparablePath(directory).startsWith(comparablePath(dataRoot + path.sep)), 'Fixture must be beneath this checkout’s .data directory.');
assert.equal(comparablePath(await realpath(directory)), comparablePath(directory), 'Fixture cannot redirect to another directory.');
for (let current = directory; comparablePath(current) !== comparablePath(dataRoot); current = path.dirname(current)) assert.equal((await lstat(current)).isSymbolicLink(), false);
const markerPath = path.join(directory, 'load-fixture.json');
assert.equal((await lstat(markerPath)).isSymbolicLink(), false);
const marker = JSON.parse(await readFile(markerPath, 'utf8'));
assert.deepEqual({ kind: marker.kind, version: marker.version, baseUrl: marker.baseUrl, syntheticOnly: marker.syntheticOnly },
  { kind: 'sparkstudio-synthetic-load', version: 1, baseUrl: base.origin, syntheticOnly: true });
assert.ok(!marker.startedAt, 'This fixture was already used; start a NEW isolated gateway data directory.');
let seconds = 30, counts = [1, 10, 50, 100], tagCount = 1000, batchSize = 100;
for (const option of options) {
  if (option.startsWith('--seconds=')) seconds = Number(option.slice(10));
  else if (option.startsWith('--clients=')) counts = option.slice(10).split(',').map(Number);
  else if (option.startsWith('--tags=')) tagCount = Number(option.slice(7));
  else if (option.startsWith('--batch-size=')) batchSize = Number(option.slice(13));
  else throw new Error(`Unknown option: ${option}`);
}
assert.ok(Number.isInteger(seconds) && seconds >= 5 && seconds <= 90, '--seconds must be 5–90; keep the 10 Hz producer below the 1,000-call script limit.');
assert.ok(counts.length >= 1 && counts.length <= 4 && counts.every(value => Number.isInteger(value) && value >= 1 && value <= 100));
assert.ok(Number.isInteger(tagCount) && tagCount >= 100 && tagCount <= 10000 && tagCount % 100 === 0, '--tags must be a multiple of 100 from 100 through 10000.');
assert.ok(Number.isInteger(batchSize) && batchSize >= 100 && batchSize <= 1000 && batchSize % 100 === 0 && tagCount % batchSize === 0,
  '--batch-size must be a multiple of 100 from 100 through 1000 and divide --tags exactly.');
const hz = 10, groups = tagCount / batchSize, run = randomUUID().slice(0, 8);
assert.ok(seconds * hz >= groups, `--seconds must be at least ${Math.ceil(groups / hz)} to update every configured tag at least once.`);
const prefix = `[default]SyntheticLoad_${run}/T`, paths = Array.from({ length: tagCount }, (_, index) => `${prefix}${index}`);
const reportPath = path.join(directory, 'runtime-load-report.json');
const report = { format: 'sparkstudio.runtime-load', version: 1, startedAt: new Date().toISOString(), baseUrl: base.origin,
  workload: { tags: tagCount, batchSize, groups, batchesPerSecond: hz, targetFullScanSeconds: groups / hz, targetUpdatesPerSecond: batchSize * hz, secondsPerStage: seconds, clients: counts,
    transport: 'real authenticated operator runtime SSE, one independent login per client',
    producer: `one manually invoked disabled gateway Python resource per stage; ${batchSize}-tag writes at ${hz} Hz, rotating through all ${tagCount} tags`,
    httpProbe: 'authenticated 10-tag read, one request every 200 ms, rotating through connected clients',
    limits: 'Synthetic memory tags only. Coalesced intermediate updates are expected. This does not measure OPC, historian, browser rendering, or production capacity.' },
  stages: [], cleanup: [], failures: [] };
const shutdown = new AbortController(), clients = new Set(); let admin, projectId, scriptRevision, publishedAt;
setMaxListeners(256, shutdown.signal); // At most 100 test streams plus bounded requests.
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => shutdown.abort(new Error(`Interrupted by ${signal}`)));

class Distribution {
  constructor() { this.bins = new Uint32Array(60001); this.count = 0; this.sum = 0; this.min = Infinity; this.max = 0; }
  add(value) { if (!Number.isFinite(value)) return; value = Math.max(0, value); this.count++; this.sum += value; this.min = Math.min(this.min, value); this.max = Math.max(this.max, value); this.bins[Math.min(60000, Math.ceil(value))]++; }
  json() { const q = p => { const target = Math.ceil(this.count * p); let n = 0; for (let i = 0; i < this.bins.length; i++) if ((n += this.bins[i]) >= target) return i; return null; };
    return { count: this.count, minMs: this.count ? this.min : null, meanMs: this.count ? this.sum / this.count : null,
      p50Ms: this.count ? q(.50) : null, p95Ms: this.count ? q(.95) : null, p99Ms: this.count ? q(.99) : null, maxMs: this.max,
      quantileResolutionMs: 1, overflowAt60000Ms: this.bins[60000] }; }
}
class Client {
  constructor(audience, project = null) { this.audience = audience; this.project = project; this.cookies = new Map(); this.csrf = null; this.loggedIn = false; clients.add(this); }
  headers(method = 'GET', body) { return { 'X-SPARK-AUDIENCE': this.audience, ...(this.project ? { 'X-SPARK-PROJECT': this.project } : {}),
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
    ...(method !== 'GET' && this.csrf ? { 'X-SPARK-CSRF': this.csrf } : {}) }; }
  async api(route, { method = 'GET', body, timeout = 15000, metric, independent = false } = {}) {
    const started = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`${method} ${route} exceeded ${timeout}ms.`)), timeout);
    const onShutdown = () => controller.abort(shutdown.signal.reason);
    if (!independent) { shutdown.signal.addEventListener('abort', onShutdown, { once: true }); if (shutdown.signal.aborted) onShutdown(); }
    try {
      const response = await fetch(new URL(route, base), { method, redirect: 'error', headers: this.headers(method, body),
        signal: controller.signal,
        body: body === undefined ? undefined : JSON.stringify(body) });
      for (const cookie of response.headers.getSetCookie()) { const item = cookie.split(';')[0], index = item.indexOf('='); this.cookies.set(item.slice(0, index), item.slice(index + 1)); }
      const text = await response.text(); if (!response.ok) throw new Error(`${method} ${route}: HTTP ${response.status}: ${text.slice(0, 160)}`);
      const value = text ? JSON.parse(text) : null;
      if (route.startsWith('/api/auth/') && value?.csrfToken) { this.csrf = value.csrfToken; this.loggedIn = true; }
      return value;
    } finally { clearTimeout(timer); shutdown.signal.removeEventListener('abort', onShutdown); metric?.add(performance.now() - started); }
  }
  async close() {
    if (!this.loggedIn) return;
    try { await this.api('/api/auth/logout', { method: 'POST', body: { audience: this.audience }, timeout: 5000, independent: true }); }
    finally { this.loggedIn = false; clients.delete(this); }
  }
}
const route = suffix => `/api/projects/${projectId}${suffix}`;
const producer = `import time
duration = parameters['seconds']
prefix = parameters['prefix']
tag_count = parameters['tagCount']
batch_size = parameters['batchSize']
assert 5 <= duration <= 90 and prefix.startswith('[default]SyntheticLoad_')
assert 100 <= tag_count <= 10000 and tag_count % 100 == 0
assert 100 <= batch_size <= 1000 and batch_size % 100 == 0 and tag_count % batch_size == 0
groups = tag_count // batch_size
assert duration * 10 >= groups
start = time.monotonic()
end = start + duration
tick = 0
batches = 0
skipped = 0
lags = []
final_values = [0] * groups
while time.monotonic() < end:
    due = start + tick * 0.1
    if due >= end:
        break
    time.sleep(max(0, due - time.monotonic()))
    now = time.monotonic()
    if now >= end:
        break
    behind = int(max(0, now - due) / 0.1)
    skipped += behind
    tick += behind
    lags.append(max(0, (now - (start + tick * 0.1)) * 1000))
    group = batches % groups
    value = max(time.time_ns() // 1000000, final_values[group] + 1)
    tag_paths = [prefix + str(group * batch_size + offset) for offset in range(batch_size)]
    qualities = system.tag.writeBlocking(tag_paths, [value] * batch_size)
    assert len(qualities) == batch_size and all(quality.isGood() for quality in qualities)
    final_values[group] = value
    batches += 1
    tick += 1
result = {'writes': batches * batch_size, 'batches': batches, 'updatedGroups': sum(1 for value in final_values if value > 0), 'skippedTicks': skipped, 'elapsedSeconds': time.monotonic() - start, 'schedulerLagMs': lags, 'finalGroupValues': final_values}
`;

function openStream(client, metrics, stageStart) {
  const controller = new AbortController(), latest = new Float64Array(tagCount).fill(-1);
  let closed = false, resolveInitial, rejectInitial, reader;
  const abortStream = () => controller.abort(shutdown.signal.reason);
  shutdown.signal.addEventListener('abort', abortStream, { once: true });
  const initial = new Promise((resolve, reject) => { resolveInitial = resolve; rejectInitial = reject; });
  // Install rejection handling immediately, even while the HTTP response is pending.
  initial.catch(() => {});
  const started = performance.now(), initialTimer = setTimeout(() => { rejectInitial(new Error('Initial SSE snapshot timed out.')); controller.abort(); }, 15000);
  function apply(values, delta) {
    const now = Date.now();
    for (const tag of values) {
      if (!tag.path?.startsWith(prefix)) { metrics.unexpectedPaths++; continue; }
      const index = Number(tag.path.slice(prefix.length));
      if (!Number.isInteger(index) || index < 0 || index >= tagCount || typeof tag.value !== 'number' || tag.quality !== 'Good') { metrics.invalidValues++; continue; }
      const previous = latest[index];
      if (previous > tag.value) metrics.regressions++;
      latest[index] = tag.value;
      if (delta && tag.value > previous && tag.value >= stageStart) metrics.delivery.add(now - tag.value);
    }
  }
  const task = (async () => {
    try {
      const response = await fetch(new URL(route(`/runtime/sessions/${client.sessionId}/messages?audience=operator`), base),
        { headers: client.headers(), redirect: 'error', signal: controller.signal });
      assert.equal(response.status, 200, 'Operator SSE connection failed');
      metrics.connect.add(performance.now() - started);
      reader = response.body.getReader(); const decoder = new TextDecoder(); let pending = '';
      while (true) {
        const next = await reader.read(); if (next.done) { if (!closed) metrics.disconnects++; break; }
        metrics.bytes += next.value.byteLength; pending += decoder.decode(next.value, { stream: true });
        assert.ok(pending.length <= 8 * 1024 * 1024, 'SSE frame exceeded the bounded test buffer.');
        let end;
        while ((end = pending.indexOf('\n\n')) >= 0) {
          const frame = pending.slice(0, end); pending = pending.slice(end + 2);
          const type = frame.split('\n').find(line => line.startsWith('event:'))?.slice(6).trim();
          const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
          if (!data) continue;
          if (type === 'tags') { const values = JSON.parse(data); assert.equal(values.length, tagCount); apply(values, !resolveInitial); metrics.snapshots++;
            metrics.snapshotBytes += Buffer.byteLength(frame) + 2; if (!resolveInitial) metrics.snapshotReplacements++;
            if (resolveInitial) { metrics.snapshot.add(performance.now() - started); clearTimeout(initialTimer); resolveInitial(); resolveInitial = null; } }
          else if (type === 'tags-delta') { const values = JSON.parse(data); apply(values.upserts, true); metrics.deltaMessages++; metrics.deltaBytes += Buffer.byteLength(frame) + 2;
            metrics.removed += values.removed.length; metrics.upserts += values.upserts.length; }
          else if (type === 'heartbeat') metrics.heartbeats++;
        }
      }
    } catch (error) { if (!closed && !shutdown.signal.aborted) { metrics.errors.push(error.message); rejectInitial(error); } }
    finally { clearTimeout(initialTimer); shutdown.signal.removeEventListener('abort', abortStream); if (resolveInitial) rejectInitial(new Error('SSE ended before initial snapshot.')); }
  })();
  return { latest, initial, async close() {
    closed = true; controller.abort();
    let timer;
    try {
      await Promise.race([
        (async () => { if (reader) try { await reader.cancel(); } catch { /* Aborted readers can already be errored. */ } await task; })(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('SSE reader did not close within five seconds.')), 5000); }),
      ]);
    } finally { clearTimeout(timer); }
  } };
}

async function stage(count, identity) {
  const result = { clients: count, startedAt: new Date().toISOString(), errors: [], cleanupErrors: [] };
  const metric = { connect: new Distribution(), snapshot: new Distribution(), delivery: new Distribution(), http: new Distribution(), login: new Distribution(),
    lag: new Distribution(), producerLag: new Distribution(), bytes: 0, deltaBytes: 0, deltaMessages: 0, snapshots: 0, snapshotBytes: 0, snapshotReplacements: 0, upserts: 0,
    removed: 0, heartbeats: 0, regressions: 0, invalidValues: 0, unexpectedPaths: 0, disconnects: 0, errors: [] };
  const operators = [], streams = []; let probeStop = false, probeTask;
  report.stages.push(result);
  try {
    const stageStart = Date.now();
    for (let index = 0; index < count; index++) {
      shutdown.signal.throwIfAborted();
      const client = new Client('operator', projectId); operators.push(client);
      await client.api('/api/auth/login', { method: 'POST', body: { ...identity, audience: 'operator', projectId }, metric: metric.login });
      client.sessionId = (await client.api(route('/runtime/sessions'), { method: 'POST', body: { publishedAt } })).sessionId;
      const stream = openStream(client, metric, stageStart); streams.push(stream); await stream.initial;
      // Stay below the intentional 100 sign-ins per 10-second gateway admission limit.
      await delay(120, undefined, { signal: shutdown.signal });
    }
    console.log(`LOAD stage ${count} clients: connected, starting ${seconds}s producer.`);
    let probes = 0, probeFailures = 0;
    probeTask = (async () => {
      let due = performance.now();
      while (!probeStop && !shutdown.signal.aborted) {
        metric.lag.add(performance.now() - due);
        try { await operators[probes % operators.length].api(route('/tags/read'), { method: 'POST', body: { paths: paths.slice(0, 10) }, metric: metric.http }); }
        catch (error) { probeFailures++; if (result.errors.length < 20) result.errors.push(error.message); }
        probes++; due += 200;
        if (due < performance.now() - 200) due = performance.now();
        await delay(Math.max(0, due - performance.now()));
      }
    })();
    const before = performance.now();
    result.producerStartedAt = new Date().toISOString();
    let produced;
    try {
      produced = await admin.api(route('/scripts/resources/load-producer/run'), { method: 'POST', timeout: (seconds + 15) * 1000,
        body: { revision: scriptRevision, source: 'draft', parameters: { seconds, prefix, tagCount, batchSize } } });
    } finally { result.producerFinishedAt = new Date().toISOString(); }
    result.producerRequestMs = performance.now() - before;
    console.log(`LOAD stage ${count}: producer response received after ${result.producerRequestMs.toFixed(0)}ms.`);
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    assert.equal(produced.success, true, produced.stderr ?? 'Producer failed.');
    const actual = produced.result;
    for (const lag of actual.schedulerLagMs) metric.producerLag.add(lag);
    result.producer = { writes: actual.writes, batches: actual.batches, updatedGroups: actual.updatedGroups, configuredGroups: groups, elapsedSeconds: actual.elapsedSeconds, skippedTicks: actual.skippedTicks,
      achievedUpdatesPerSecond: actual.writes / actual.elapsedSeconds, sustainedAtLeast95PercentOfTarget: actual.writes / actual.elapsedSeconds >= batchSize * hz * .95,
      schedulingLag: metric.producerLag.json() };
    assert.ok(actual.finalGroupValues.length === groups && actual.finalGroupValues.every(value => value > 0), 'Producer must update every configured tag group at least once.');
    const deadline = performance.now() + 10000;
    const matches = stream => stream.latest.every((value, index) => value === actual.finalGroupValues[Math.floor(index / batchSize)]);
    while (!streams.every(matches) && performance.now() < deadline) await delay(100, undefined, { signal: shutdown.signal });
    result.convergence = { clients: count, converged: streams.filter(matches).length, waitMs: Math.max(0, 10000 - (deadline - performance.now())),
      mismatchedTags: streams.reduce((sum, stream) => sum + stream.latest.reduce((n, value, index) => n + Number(value !== actual.finalGroupValues[Math.floor(index / batchSize)]), 0), 0) };
    console.log(`LOAD stage ${count}: final convergence ${result.convergence.converged}/${count}; stopping HTTP probes.`);
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    probeStop = true; await probeTask;
    result.httpProbes = { count: probes, failed: probeFailures, latency: metric.http.json() };
    result.integrityPassed = result.convergence.converged === count && !probeFailures && !metric.errors.length && !metric.disconnects && !metric.regressions && !metric.invalidValues && !metric.unexpectedPaths && !metric.removed;
    result.passed = result.integrityPassed && result.producer.sustainedAtLeast95PercentOfTarget;
  } catch (error) { result.errors.push(error.message); result.passed = false; }
  finally {
    console.log(`LOAD stage ${count}: cleaning up probes, streams and sessions.`);
    probeStop = true; if (probeTask) await probeTask;
    await Promise.all(streams.map(async stream => { try { await stream.close(); } catch (error) { result.cleanupErrors.push(error.message); } }));
    console.log(`LOAD stage ${count}: streams closed; removing runtime sessions.`);
    for (const client of operators) {
      try { if (client.sessionId) await client.api(route(`/runtime/sessions/${client.sessionId}`), { method: 'DELETE', independent: true, timeout: 5000 }); }
      catch (error) { result.cleanupErrors.push(error.message); }
      try { await client.close(); } catch (error) { result.cleanupErrors.push(error.message); }
    }
    result.finishedAt = new Date().toISOString(); result.loginLatency = metric.login.json(); result.clientSchedulingLag = metric.lag.json();
    result.sse = { connectLatency: metric.connect.json(), initialSnapshotLatency: metric.snapshot.json(), deliveryLatency: metric.delivery.json(),
      bytes: metric.bytes, deltaBytes: metric.deltaBytes, deltaMessages: metric.deltaMessages, snapshots: metric.snapshots, snapshotBytes: metric.snapshotBytes,
      snapshotReplacements: metric.snapshotReplacements, upserts: metric.upserts,
      heartbeats: metric.heartbeats, regressions: metric.regressions, removed: metric.removed, unexpectedPaths: metric.unexpectedPaths,
      invalidValues: metric.invalidValues, disconnects: metric.disconnects, errors: metric.errors.slice(0, 20) };
    if (result.cleanupErrors.length) result.passed = false;
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    console.log(`LOAD stage ${count}: ${result.passed ? 'PASS' : 'FAIL'}, ${result.producer?.achievedUpdatesPerSecond?.toFixed(1) ?? '?'} updates/s; SSE p95 ${result.sse.deliveryLatency.p95Ms}ms.`);
  }
}

try {
  admin = new Client('engineering');
  const anonymous = await admin.api('/api/auth/session?audience=engineering');
  assert.equal(anonymous.setupRequired, true, 'Refusing an initialized gateway: use a fresh synthetic fixture.');
  // A wrong URL/directory cannot bootstrap: only the named directory’s one-time secret is accepted.
  const setupCode = (await readFile(path.join(directory, 'security', 'setup-code.txt'), 'utf8')).trim();
  const adminIdentity = { username: `load-admin-${run}`, password: randomBytes(24).toString('base64url') };
  await admin.api('/api/auth/setup', { method: 'POST', body: { ...adminIdentity, setupCode } });
  await writeFile(markerPath, JSON.stringify({ ...marker, startedAt: report.startedAt, run }, null, 2));
  assert.deepEqual(await admin.api('/api/connections'), [], 'Synthetic load gateway must have no connections.');
  assert.deepEqual(await admin.api('/api/tag-definitions'), [], 'Synthetic load gateway must initially have no tags.');
  report.gateway = await admin.api('/api/health');
  assert.equal(report.gateway.demoMode, false); assert.equal(report.gateway.pythonAvailable, true);
  // Chunk setup imports to remain below the unchanged 1 MiB HTTP request limit.
  for (let offset = 0; offset < paths.length; offset += 1000) {
    const package_ = { format: 'sparkstudio.tags', version: 1, tags: paths.slice(offset, offset + 1000).map(tagPath => ({ path: tagPath, kind: 'memory', dataType: 'Double', value: 0 })) };
    const preview = await admin.api('/api/tag-engineering/preview', { method: 'POST', body: package_ });
    await admin.api('/api/tag-engineering/apply', { method: 'POST', body: { package: package_, revision: preview.revision, previewToken: preview.previewToken } });
  }
  projectId = (await admin.api('/api/projects', { method: 'POST', body: { name: `Synthetic load ${run}` } })).id;
  admin.project = projectId;
  let draft = await admin.api(route('/project'));
  delete draft.navigation; draft.parameters = {}; draft.templates = [];
  draft.screens = [{ id: 'main', name: 'Synthetic load', width: 800, height: 600, parameters: {}, components: [{ id: 'label', type: 'label', x: 10, y: 10, width: 300, height: 80, props: { text: 'Synthetic load fixture' } }] }];
  draft = await admin.api(route('/project'), { method: 'PUT', body: draft });
  const scripts = await admin.api(route('/scripts/resources'));
  const saved = await admin.api(route('/scripts/resources'), { method: 'PUT', body: { revision: scripts.revision, resources: [{ id: 'load-producer', name: 'SyntheticLoadProducer', type: 'gateway', event: 'message', enabled: false,
    code: producer, timeoutMs: (seconds + 10) * 1000, threading: 'dedicated', parameters: { seconds, prefix, tagCount, batchSize } }] } });
  scriptRevision = saved.revision;
  publishedAt = (await admin.api(route('/project/publish'), { method: 'POST', body: { revision: draft.revision } })).publishedAt;
  const securitySettings = await admin.api('/api/security/settings');
  await admin.api('/api/security/settings', { method: 'PUT', body: { ...securitySettings,
    projectTagPrefixes: { [projectId]: [prefix.slice(0, prefix.lastIndexOf('/') + 1)] } } });
  const identity = { username: `load-viewer-${run}`, password: randomBytes(24).toString('base64url') };
  await admin.api('/api/security/users', { method: 'POST', body: { ...identity, displayName: 'Synthetic load viewer', projectGrants: { [projectId]: { view: true, operate: false, design: false, publish: false } } } });
  for (const count of counts) { shutdown.signal.throwIfAborted(); await stage(count, identity); }
} catch (error) { report.failures.push(error.message); }
finally {
  for (const client of clients) try { await client.close(); } catch (error) { report.cleanup.push(error.message); }
  report.finishedAt = new Date().toISOString(); report.passed = !report.failures.length && !report.cleanup.length && report.stages.length === counts.length && report.stages.every(value => value.passed);
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(`Runtime load report: ${reportPath}`);
  if (!report.passed) { console.error(JSON.stringify({ failures: report.failures, failedStages: report.stages.filter(value => !value.passed).map(value => value.clients) })); process.exitCode = 1; }
}
