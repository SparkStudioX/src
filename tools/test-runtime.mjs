// Publication isolation tests; use a disposable local gateway on port 5091.
import assert from 'node:assert/strict';

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:5091');
assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname));
assert.equal(base.port, '5091');
assert.equal(base.protocol, 'http:');
assert.equal(base.pathname, '/');
assert.ok(!base.username && !base.password && !base.search && !base.hash);
let passed = 0;
async function api(path, method = 'GET', body, status = 200) {
  const response = await fetch(new URL(path, base), {
    method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000), redirect: 'error',
  });
  const content = await response.json();
  assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(content)}`);
  return content;
}
async function test(name, action) {
  await action();
  passed++;
  console.log(`PASS ${name}`);
}
const original = await api('/api/project');
const originalQueries = await api('/api/queries');
const originalQuery = originalQueries.find(query => query.id === 'production-summary');
let queryChanged = false;
let projectChanged = false;
try {
  const metadata = await api('/api/project/publication');
  if (!metadata.published) {
    await test('unpublished runtime returns an explicit 404', async () => {
      await api('/api/runtime/project', 'GET', undefined, 404);
      await api('/api/runtime/queries', 'GET', undefined, 404);
    });
  }
  await test('stale publication revision is rejected', async () => {
    await api('/api/project/publish', 'POST', { revision: original.revision - 1 }, 409);
    assert.deepEqual(await api('/api/project/publication'), metadata);
  });
  await test('publishing captures saved screens and metadata without exposing script source', async () => {
    const publication = await api('/api/project/publish', 'POST', { revision: original.revision });
    assert.equal(publication.published, true);
    assert.equal(publication.revision, original.revision);
    assert.ok(Number.isFinite(Date.parse(publication.publishedAt)));
    const runtime = await api('/api/runtime/project');
    assert.equal(runtime.publishedAt, publication.publishedAt);
    delete runtime.publishedAt;
    const publicProject = structuredClone(original);
    for (const component of [...publicProject.screens, ...(publicProject.templates ?? [])].flatMap(document => document.components)) delete component.props?.script;
    for (const component of [...runtime.screens, ...(runtime.templates ?? [])].flatMap(document => document.components))
      assert.ok(!Object.hasOwn(component.props ?? {}, 'script'), 'Operator projects must not expose authored Python source.');
    assert.deepEqual(runtime, publicProject);
  });
  await test('runtime query list omits SQL and connection details', async () => {
    const queries = await api('/api/runtime/queries');
    assert.ok(queries.some(query => query.id === 'production-summary'));
    for (const query of queries) assert.deepEqual(Object.keys(query).sort(), ['id', 'name', 'parameters']);
  });
  await test('runtime executes only queries in the publication', async () => {
    const data = await api('/api/runtime/queries/production-summary/execute', 'POST', { parameters: { line: 'Line2' } });
    assert.equal(data.rows.length, 1);
    assert.equal(data.rows[0].Line, 'Line2');
    await api('/api/runtime/queries/unpublished-query/execute', 'POST', { parameters: {} }, 404);
  });
  await test('saved draft edits do not change operator screens', async () => {
    const draft = structuredClone(original);
    draft.screens[0].name = 'Unpublished draft screen';
    await api('/api/project', 'PUT', draft);
    projectChanged = true;
    const runtime = await api('/api/runtime/project');
    assert.equal(runtime.screens[0].name, original.screens[0].name);
    assert.equal(runtime.revision, original.revision);
  });
  await test('named query draft edits do not affect published queries', async () => {
    await api('/api/queries/production-summary', 'PUT', { ...originalQuery, sql: 'SELECT DraftOnly FROM Unpublished' });
    queryChanged = true;
    await api('/api/queries/production-summary/execute', 'POST', { parameters: { line: 'Line1' } }, 400);
    const data = await api('/api/runtime/queries/production-summary/execute', 'POST', { parameters: { line: 'Line1' } });
    assert.equal(data.rows[0].Line, 'Line1');
  });
  await test('publishing a missing table query preserves the prior release', async () => {
    const current = await api('/api/project');
    const table = current.screens.flatMap(screen => screen.components).find(component => component.type === 'table');
    table.props.queryId = 'missing-query';
    const saved = await api('/api/project', 'PUT', current);
    const before = await api('/api/project/publication');
    await api('/api/project/publish', 'POST', { revision: saved.revision }, 400);
    assert.deepEqual(await api('/api/project/publication'), before);
  });
  await test('invalid screen dimensions cannot replace an operator release', async () => {
    const current = await api('/api/project');
    const invalid = structuredClone(original);
    invalid.revision = current.revision;
    invalid.screens[0].width = 0;
    const saved = await api('/api/project', 'PUT', invalid);
    const before = await api('/api/project/publication');
    await api('/api/project/publish', 'POST', { revision: saved.revision }, 400);
    assert.deepEqual(await api('/api/project/publication'), before);
  });
  await test('broken navigation cannot replace an operator release', async () => {
    const current = await api('/api/project');
    const invalid = structuredClone(original);
    invalid.revision = current.revision;
    invalid.screens[0].components.push({ id: 'invalid-navigation', type: 'button', x: 0, y: 0, width: 200, height: 60, props: { text: 'Missing screen', targetScreenId: 'missing' } });
    const saved = await api('/api/project', 'PUT', invalid);
    const before = await api('/api/project/publication');
    await api('/api/project/publish', 'POST', { revision: saved.revision }, 400);
    assert.deepEqual(await api('/api/project/publication'), before);
  });
} finally {
  if (queryChanged) await api('/api/queries/production-summary', 'PUT', originalQuery);
  if (projectChanged) {
    const current = await api('/api/project');
    const restored = await api('/api/project', 'PUT', { ...original, revision: current.revision });
    await api('/api/project/publish', 'POST', { revision: restored.revision });
  }
}
console.log(`${passed}/${passed} publication checks passed; original project and query content restored and published.`);
