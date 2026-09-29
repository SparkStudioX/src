#!/usr/bin/env node
// Run against a disposable gateway using an isolated data directory on port 5091.
// Usage: node tools/test-gateway.mjs [http://127.0.0.1:5091] [--sse]
// This script temporarily saves the project, then restores its contents with a new revision.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

const arguments_ = process.argv.slice(2);
const unknownFlags = arguments_.filter(value => value.startsWith('--') && value !== '--sse');
assert.equal(unknownFlags.length, 0, `Unknown options: ${unknownFlags.join(', ')}`);
const addresses = arguments_.filter(value => !value.startsWith('--'));
assert.ok(addresses.length <= 1, 'Pass at most one gateway base URL.');
const base = new URL(addresses[0] ?? 'http://127.0.0.1:5091');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), 'Smoke tests require a local isolated gateway.');
assert.equal(base.port, '5091', 'Smoke tests are restricted to the isolated test gateway on port 5091.');
assert.equal(base.protocol, 'http:', 'Use the local HTTP test gateway.');
assert.equal(base.pathname, '/', 'The base URL must not include a path.');
assert.ok(!base.username && !base.password && !base.search && !base.hash, 'The base URL must not include credentials, a query or a fragment.');
const runSse = arguments_.includes('--sse');
const outcomes = [];

async function request(path, { method = 'GET', body, status = 200, headers = {}, timeoutMs = 15_000 } = {}) {
  const response = await fetch(new URL(path, base), {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'error',
  });
  const raw = await response.text();
  assert.equal(response.status, status, `${method} ${path}: expected HTTP ${status}, received ${response.status}: ${raw.slice(0, 500)}`);
  if (!raw) return null;
  try { return JSON.parse(raw); }
  catch { assert.fail(`${method} ${path}: response is not JSON: ${raw.slice(0, 500)}`); }
}

async function test(name, action) {
  const started = performance.now();
  try {
    await action();
    outcomes.push({ name, success: true });
    console.log(`PASS ${name} (${Math.round(performance.now() - started)} ms)`);
  } catch (error) {
    outcomes.push({ name, success: false });
    console.error(`FAIL ${name}: ${error.stack ?? error}`);
  }
}

function requireObject(value, context) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${context} must be an object.`);
  return value;
}

function requireTags(value, context) {
  assert.ok(Array.isArray(value), `${context} must return an array of tags.`);
  for (const tag of value) {
    requireObject(tag, context);
    assert.equal(typeof tag.path, 'string');
    assert.equal(typeof tag.quality, 'string');
    assert.ok(Number.isFinite(Date.parse(tag.timestamp)), `Invalid tag timestamp for ${tag.path}.`);
  }
  return value;
}

const read = (paths, parameters) => request('/api/tags/read', { method: 'POST', body: { paths, parameters } });
const script = code => request('/api/scripts/run', { method: 'POST', body: { code }, timeoutMs: 30_000 });
const withoutRevision = project => {
  const result = structuredClone(project);
  delete result.revision;
  return result;
};

console.log(`Testing isolated SparkStudio gateway at ${base.origin}`);

await test('gateway health', async () => {
  const health = requireObject(await request('/api/health'), 'Health');
  assert.equal(health.status, 'ok');
  assert.equal(health.demoMode, true);
  assert.equal(health.pythonAvailable, true, 'The isolated test gateway must have a configured Python runtime.');
});

await test('seed project contains the overview and indirect bindings', async () => {
  const project = requireObject(await request('/api/project'), 'Project');
  const catalog = requireObject(await request('/api/projects'), 'Project catalog');
  assert.equal(project.id, catalog.defaultProjectId);
  assert.ok(catalog.projects.some(item => item.id === project.id && item.isDefault), 'Seed project is not the catalog default.');
  assert.ok(Number.isInteger(project.revision) && project.revision >= 0);
  assert.equal(project.parameters.line, 'Line1');
  const screen = project.screens.find(item => item.id === 'overview');
  assert.ok(screen, 'Seed overview screen is missing.');
  assert.ok(screen.components.some(item => item.props?.tagPath === '[default]Line/{line}/Speed'));
  assert.ok(screen.components.some(item => item.props?.queryId === 'production-summary'));
});

await test('tag snapshot distinguishes simulated values', async () => {
  const tags = requireTags(await request('/api/tags'), 'Tag snapshot');
  for (const line of ['Line1', 'Line2']) {
    const speed = tags.find(tag => tag.path === `[default]Line/${line}/Speed`);
    assert.ok(speed, `${line} speed is missing.`);
    assert.equal(speed.source, 'simulated');
    assert.equal(speed.quality, 'Good');
    assert.equal(typeof speed.value, 'number');
    assert.ok(Number.isFinite(speed.value));
  }
});

await test('indirect bindings resolve and switch assets', async () => {
  const pattern = '[default]Line/{line}/Speed';
  const first = requireTags(await read([pattern], { line: 'Line1' }), 'Line1 read');
  const second = requireTags(await read([pattern], { line: 'Line2' }), 'Line2 read');
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.equal(first[0].path, '[default]Line/Line1/Speed');
  assert.equal(second[0].path, '[default]Line/Line2/Speed');
  assert.equal(first[0].quality, 'Good');
  assert.equal(second[0].quality, 'Good');
  assert.notEqual(first[0].value, second[0].value);
});

await test('missing indirect binding parameter returns HTTP 400', async () => {
  await request('/api/tags/read', { method: 'POST', body: { paths: ['[default]Line/{line}/Speed'], parameters: {} }, status: 400 });
});

await test('unknown tag returns Bad_NotFound', async () => {
  const tags = requireTags(await read(['[default]SmokeTest/DoesNotExist']), 'Unknown tag read');
  assert.equal(tags.length, 1);
  assert.equal(tags[0].path, '[default]SmokeTest/DoesNotExist');
  assert.equal(tags[0].quality, 'Bad_NotFound');
  assert.equal(tags[0].value, null);
});

let originalProject;
let mutationAttempted = false;
try {
  await test('project saves advance revisions and reject stale saves', async () => {
    originalProject = requireObject(await request('/api/project'), 'Original project');
    const changed = structuredClone(originalProject);
    changed.name = `${originalProject.name} [gateway smoke test]`;
    mutationAttempted = true;
    const saved = requireObject(await request('/api/project', { method: 'PUT', body: changed }), 'Saved project');
    assert.equal(saved.revision, originalProject.revision + 1);
    assert.equal(saved.name, changed.name);
    await request('/api/project', { method: 'PUT', body: originalProject, status: 409 });
    const current = await request('/api/project');
    assert.deepEqual(current, saved, 'A rejected stale save must not modify the project.');
  });

  await test('invalid component is rejected without changing the project', async () => {
    const current = requireObject(await request('/api/project'), 'Current project');
    const invalid = structuredClone(current);
    invalid.screens[0].components[0].type = 'unsupported-smoke-test-component';
    await request('/api/project', { method: 'PUT', body: invalid, status: 400 });
    assert.deepEqual(await request('/api/project'), current, 'A rejected invalid save must not change data or revision.');
  });

  await test('null and non-object screens are rejected without saving', async () => {
    const current = await request('/api/project');
    for (const malformed of [null, 'invalid-screen', 42, []]) {
      const invalid = structuredClone(current);
      invalid.screens.push(malformed);
      await request('/api/project', { method: 'PUT', body: invalid, status: 400 });
      assert.deepEqual(await request('/api/project'), current, 'Malformed screens must not change data or revision.');
    }
  });

  await test('null and non-object components are rejected without saving', async () => {
    const current = await request('/api/project');
    for (const malformed of [null, 'invalid-component', 42, []]) {
      const invalid = structuredClone(current);
      invalid.screens[0].components.push(malformed);
      await request('/api/project', { method: 'PUT', body: invalid, status: 400 });
      assert.deepEqual(await request('/api/project'), current, 'Malformed components must not change data or revision.');
    }
  });
} finally {
  if (mutationAttempted && originalProject) {
    await test('restore original project contents using the current revision', async () => {
      const current = await request('/api/project');
      const restore = structuredClone(originalProject);
      restore.revision = current.revision;
      const restored = await request('/api/project', { method: 'PUT', body: restore });
      assert.equal(restored.revision, current.revision + 1);
      assert.deepEqual(withoutRevision(restored), withoutRevision(originalProject));
      assert.deepEqual(await request('/api/project'), restored);
    });
  }
}

await test('sample named query filters rows to the requested line', async () => {
  const result = requireObject(await request('/api/queries/production-summary/execute', {
    method: 'POST', body: { parameters: { line: 'Line1' } },
  }), 'Named query result');
  assert.ok(Array.isArray(result.columns) && result.columns.includes('Line'));
  assert.ok(Array.isArray(result.rows) && result.rows.length > 0);
  assert.ok(result.rows.every(row => row.Line === 'Line1'), 'Named query returned rows from another line.');
});

await test('unknown named query returns HTTP 404', async () => {
  await request('/api/queries/missing-smoke-test-query/execute', { method: 'POST', body: { parameters: {} }, status: 404 });
});

await test('Python reads current gateway tags through system.tag', async () => {
  const execution = requireObject(await script("values = system.tag.readBlocking(['[default]Line/Line1/Speed'])\nprint(values[0].quality.isGood())\nresult = values[0].value"), 'Script execution');
  assert.equal(execution.success, true, JSON.stringify(execution));
  assert.match(execution.stdout, /\bTrue\b/);
  assert.equal(typeof execution.result, 'number');
  assert.ok(Number.isFinite(execution.result));
});

await test('Python runs a named query through system.db', async () => {
  const execution = requireObject(await script("result = system.db.runNamedQuery('production-summary', {'line': 'Line2'}).getRowCount()"), 'Named query script');
  assert.equal(execution.success, true, JSON.stringify(execution));
  assert.ok(Number.isInteger(execution.result) && execution.result > 0, 'Named query should return at least one Line2 row.');
});

await test('Python syntax errors produce an unsuccessful result', async () => {
  const execution = requireObject(await script('def incomplete(:\n    pass'), 'Syntax-error script');
  assert.equal(execution.success, false);
  assert.match(JSON.stringify(execution), /SyntaxError/);
});

await test('runaway Python is terminated at the execution timeout', async () => {
  const started = performance.now();
  const execution = requireObject(await script('while True:\n    pass'), 'Timeout script');
  const elapsed = performance.now() - started;
  assert.equal(execution.success, false);
  assert.match(JSON.stringify(execution), /timed?\s*out|timeout|execution limit/i);
  assert.ok(elapsed >= 9_000 && elapsed < 25_000, `Expected a 10-second execution limit; observed ${Math.round(elapsed)} ms.`);
  assert.equal((await script('result = 42')).result, 42, 'A script should run after a timed-out worker is terminated.');
});

await test('cross-origin script execution is rejected', async () => {
  await request('/api/scripts/run', {
    method: 'POST', body: { code: 'result = 42' }, headers: { Origin: 'https://untrusted.example' }, status: 403,
  });
});

if (runSse) {
  await test('SSE emits a tag message and permits cancellation', async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    let reader;
    try {
      const response = await fetch(new URL('/api/events', base), { signal: controller.signal, redirect: 'error' });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
      assert.ok(response.body, 'SSE response has no stream.');
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let text = '';
      while (!text.includes('\n\n')) {
        const part = await reader.read();
        assert.equal(part.done, false, 'SSE ended before its first event.');
        text += decoder.decode(part.value, { stream: true }).replace(/\r\n/g, '\n');
        assert.ok(text.length < 1_000_000, 'SSE message exceeded the smoke-test limit.');
      }
      const events = text.split('\n\n');
      const event = events.find(item => item.split('\n').some(line => line.startsWith('data:')));
      assert.ok(event, 'First SSE message contained no data.');
      assert.match(event, /^event: tags$/m);
      const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      const tags = requireTags(JSON.parse(data), 'SSE tag payload');
      assert.ok(tags.some(tag => tag.source === 'simulated'));
    } finally {
      clearTimeout(timer);
      controller.abort();
      await reader?.cancel().catch(() => {});
    }
  });
}

const failures = outcomes.filter(outcome => !outcome.success);
console.log(`\n${outcomes.length - failures.length}/${outcomes.length} gateway smoke checks passed.${runSse ? '' : ' SSE check not requested (use --sse).'} Real OPC UA and SQL Server interoperability are not tested by sample data.`);
process.exitCode = failures.length ? 1 : 0;
