#!/usr/bin/env node
// Gateway integration coverage for query-backed dropdowns. Local disposable port
// 5091 only; creates its own project and SQLite database, archives the project.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:5091');
assert.ok(process.argv.length <= 3);
assert.equal(base.protocol, 'http:');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname));
assert.equal(base.port, '5091', 'Query-control tests require the isolated gateway on port 5091.');
assert.equal(base.pathname, '/');
assert.ok(!base.username && !base.password && !base.search && !base.hash);
async function request(path, {method = 'GET', body, raw, status = 200, binary = false} = {}) {
  const response = await fetch(new URL(path, base), {method, headers: raw ? {'Content-Type': 'application/zip'} : body === undefined ? {} : {'Content-Type': 'application/json'}, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)), redirect: 'error', signal: AbortSignal.timeout(30000)});
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, status, `${method} ${path}: ${response.status} ${bytes.toString('utf8').slice(0, 600)}`);
  return binary ? bytes : bytes.length ? JSON.parse(bytes.toString('utf8')) : null;
}
let passed = 0;
async function test(name, run) { await run(); passed++; console.log(`PASS ${name}`); }
const run = randomUUID().replaceAll('-', '').slice(0, 12);
const connection = {id: `choices-${run}`, name: 'Query control test database', type: 'sqlite', database: `choices-${run}.db`};
const created = [];
let projectId;
let draft;
let publishedAt;
const route = suffix => `/api/projects/${projectId}${suffix}`;
const source = {queryId: 'choices', valueColumn: 'value', labelColumn: 'label'};
const component = (id, type, props, y = 0) => ({id, type, x: 0, y, width: 260, height: 64, props});
const dropdown = () => component('choice', 'select', {fieldKey: 'choice', defaultValue: '', optionsSource: structuredClone(source), selectionFields: {quantity: 'quantity'}});
const button = () => component('apply', 'button', {text: 'Apply', action: 'script', script: "result = {'inputs': inputs, 'parameters': parameters}"}, 160);
const query = (sql, parameters = []) => ({id: 'choices', name: 'Test choices', connectionId: connection.id, kind: 'query', sql, parameters});
const originalSql = 'SELECT id AS value, machine AS label, quantity FROM production_records WHERE @filter = \'\' OR machine = @filter ORDER BY id';
const parameter = (name, defaultValue) => ({name, type: 'string', ...(defaultValue === undefined ? {} : {defaultValue})});
const saveQuery = (definition = query(originalSql, [parameter('filter', '')])) => request(route('/queries/choices'), {method: 'PUT', body: definition});
async function save(project = draft) { draft = await request(route('/project'), {method: 'PUT', body: project}); return draft; }
async function publish() {
  const metadata = await request(route('/project/publish'), {method: 'POST', body: {revision: draft.revision}});
  publishedAt = metadata.publishedAt;
}
const action = (choice, {status = 200, screen = 'main', ...body} = {}) => request(route(`/runtime/screens/${screen}/components/apply/action`), {method: 'POST', status, body: {publishedAt, inputs: {choice, quantity: 0}, ...body}});
let failure;
try {
  assert.equal((await request('/api/health')).pythonAvailable, true, 'Integration checks need the bundled Python runtime.');
  const createdProject = await request('/api/projects', {method: 'POST', body: {name: `Query controls ${run}`}});
  projectId = createdProject.id; created.push(projectId);
  await request('/api/connections', {method: 'POST', body: connection});
  assert.equal((await request(`/api/connections/${connection.id}/database`, {method: 'POST', body: {initializeSampleData: true}})).success, true);
  draft = await request(route('/project'));
  draft.parameters = {line: 'Line1', unrelated: 'Ignored by options query'};
  draft.screens = [{id: 'main', name: 'Choice form', width: 800, height: 600, components: [dropdown(), component('quantity', 'numberInput', {fieldKey: 'quantity', defaultValue: 0, min: 0}), button()]}];
  await saveQuery();
  await save();

  await test('draft accepts query-backed dropdown with empty default and no static options', async () => {
    assert.equal(draft.screens[0].components[0].props.defaultValue, '');
    assert.deepEqual(draft.screens[0].components[0].props.optionsSource, source);
  });
  await test('source shape, bounds and same-scope selection mappings are validated atomically', async () => {
    const changes = [
      props => { props.optionsSource = null; },
      props => { props.optionsSource.queryId = ''; },
      props => { props.optionsSource.valueColumn = 'x'.repeat(129); },
      props => { props.optionsSource.extra = 'invalid'; },
      props => { delete props.optionsSource.labelColumn; },
      props => { props.defaultValue = 1; },
      props => { props.selectionFields = {missing: 'quantity'}; },
      props => { props.selectionFields = {choice: 'value'}; },
      props => { props.selectionFields = {quantity: ''}; },
    ];
    for (const change of changes) {
      const invalid = structuredClone(draft); change(invalid.screens[0].components[0].props);
      await request(route('/project'), {method: 'PUT', body: invalid, status: 400});
    }
    const radio = structuredClone(draft); radio.screens[0].components[0].type = 'radioGroup';
    await request(route('/project'), {method: 'PUT', body: radio, status: 400});
    assert.equal((await request(route('/project'))).revision, draft.revision);
  });
  await test('publication requires existing read query and preserves previous publication on failure', async () => {
    await publish(); const before = publishedAt;
    draft.screens[0].components[0].props.optionsSource.queryId = 'missing'; await save();
    await request(route('/project/publish'), {method: 'POST', body: {revision: draft.revision}, status: 400});
    assert.equal((await request(route('/runtime/project'))).publishedAt, before);
    draft.screens[0].components[0].props.optionsSource.queryId = 'choices'; await save();
    await saveQuery({...query('UPDATE production_records SET quantity = 0'), kind: 'update'});
    await request(route('/project/publish'), {method: 'POST', body: {revision: draft.revision}, status: 400});
    await saveQuery(); await publish();
  });
  await test('published dropdown queries are exposed and scalar numeric options validate as strings', async () => {
    const queries = await request(route('/runtime/queries')); assert.deepEqual(queries.map(item => item.id), ['choices']);
    const rows = await request(route('/runtime/queries/choices/execute'), {method: 'POST', body: {parameters: {}}});
    assert.equal(rows.rows.length, 3);
    const result = await action('2'); assert.equal(result.success, true, result.stderr);
    assert.equal(result.result.inputs.choice, '2');
    assert.equal(result.result.parameters.unrelated, 'Ignored by options query');
  });
  await test('unknown, empty, nontext and stale database values never execute the action', async () => {
    for (const value of ['', 'missing', '4', null, 1, true, {}, 'x'.repeat(4097)]) await action(value, {status: 400});
    await request(route('/queries/remove'), {method: 'PUT', body: {...query('DELETE FROM production_records WHERE id = @id', [{name: 'id', type: 'int'}]), id: 'remove', name: 'Remove test record', kind: 'update'}});
    await request(route('/queries/remove/execute'), {method: 'POST', body: {parameters: {id: 3}}});
    await action('3', {status: 400});
  });
  await test('action uses captured published query, then rejects old client publication identity', async () => {
    await saveQuery(query("SELECT 'draft-only' AS value, 'Draft' AS label, 0 AS quantity"));
    assert.equal((await action('1')).success, true);
    await action('draft-only', {status: 400});
    const before = publishedAt; await publish();
    await action('draft-only', {publishedAt: before, status: 409});
    await action('1', {status: 400});
    assert.equal((await action('draft-only')).success, true);
  });
  await test('runtime query metadata and execution atomically reject stale publication tokens', async () => {
    const before = publishedAt;
    const metadataPath = `/runtime/queries?publishedAt=${encodeURIComponent(before)}`;
    assert.equal((await request(route(metadataPath)))[0].id, 'choices');
    const first = await request(route('/runtime/queries/choices/execute'), {method: 'POST', body: {publishedAt: before, parameters: {}}});
    assert.equal(first.rows[0].value, 'draft-only');
    await saveQuery(query("SELECT 'new-publication' AS value, 'New' AS label, 0 AS quantity")); await publish();
    // Metadata fetched before publication must not authorize execution afterward.
    await request(route(metadataPath), {status: 409});
    await request(route('/runtime/queries/choices/execute'), {method: 'POST', body: {publishedAt: before, parameters: {}}, status: 409});
    const next = await request(route('/runtime/queries/choices/execute'), {method: 'POST', body: {publishedAt, parameters: {}}});
    assert.equal(next.rows[0].value, 'new-publication');
    assert.equal((await request(route('/runtime/queries')))[0].id, 'choices', 'Legacy metadata calls remain compatible.');
    assert.equal((await request(route('/runtime/queries/choices/execute'), {method: 'POST', body: {parameters: {}}})).rows[0].value, 'new-publication');
  });
  await test('query defaults and declared context overrides filter membership without unrelated parameters', async () => {
    await saveQuery(query(originalSql, [parameter('filter', 'Press02')])); await publish();
    assert.equal((await action('2')).success, true); await action('1', {status: 400});
    draft.parameters.filter = ''; await save(); await publish();
    assert.equal((await action('1', {parameters: {filter: 'Press01'}})).success, true);
    await action('2', {parameters: {filter: 'Press01'}, status: 400});
  });
  await test('malformed and duplicate option rows fail the entire choice set', async () => {
    for (const sql of [
      "SELECT 'a' AS value, 'First' AS label UNION ALL SELECT 'a', 'Second'",
      "SELECT 1 AS value, 'First' AS label UNION ALL SELECT '1', 'Second'",
      "SELECT 'a' AS value, NULL AS label",
      "SELECT '' AS value, 'Empty' AS label",
      "SELECT 'a' AS value, '' AS label",
      "SELECT ' ' AS value, 'Whitespace' AS label",
      "SELECT 'a' AS value, '\ufeff' AS label",
      "SELECT NULL AS value, 'Null' AS label",
      "SELECT 'a' AS missing, 'Label' AS label",
      `SELECT '${'x'.repeat(4097)}' AS value, 'Long' AS label`,
      `SELECT 'a' AS value, '${'x'.repeat(201)}' AS label`,
      "SELECT 9007199254740992 AS value, 'Unsafe integer' AS label",
    ]) { await saveQuery(query(sql)); await publish(); await action('a', {status: 400}); }
  });
  await test('numeric canonical text matches browser exponent and decimal formatting', async () => {
    await saveQuery(query("SELECT 0.0000001 AS value, 0.000001 AS label UNION ALL SELECT -0.0000002, 2.5 UNION ALL SELECT 1000000000000000, 3 UNION ALL SELECT 0.000001, 4")); await publish();
    for (const value of ['1e-7', '-2e-7', '1000000000000000', '0.000001']) assert.equal((await action(value)).success, true);
  });
  await test('empty results and more than 500 rows fail closed, exactly 500 succeeds', async () => {
    await saveQuery(query('SELECT id AS value, machine AS label FROM production_records WHERE id < 0')); await publish(); await action('1', {status: 400});
    const rows = 'SELECT CAST(row_number() OVER () AS TEXT) AS value, \'Option\' AS label FROM production_records a CROSS JOIN production_records b CROSS JOIN production_records c CROSS JOIN production_records d CROSS JOIN production_records e CROSS JOIN production_records f CROSS JOIN production_records g CROSS JOIN production_records h CROSS JOIN production_records i CROSS JOIN production_records j';
    await saveQuery(query(`${rows} LIMIT 501`)); await publish(); await action('1', {status: 400});
    await saveQuery(query(`${rows} LIMIT 500`)); await publish(); assert.equal((await action('500')).success, true);
  });
  await test('screen, template, repeater and popup actions validate within their resolved parameter scopes', async () => {
    await saveQuery(query('SELECT @line AS value, @line AS label, 0 AS quantity', [parameter('line')]));
    draft.screens[0].parameters = {line: 'Screen'};
    draft.templates = [{id: 'choice-form', name: 'Reusable choices', width: 300, height: 240, parameters: {line: 'Template'}, components: [dropdown(), component('quantity', 'numberInput', {fieldKey: 'quantity', defaultValue: 0}), button()]}];
    draft.screens[0].components.push(component('instance', 'template', {templateId: 'choice-form', parameters: {line: 'Instance'}}, 250));
    draft.screens[0].components.push(component('repeat', 'repeater', {templateId: 'choice-form', columns: 1, gap: 0, rows: [{id: 'one', parameters: {line: 'RowOne'}}, {id: 'two', parameters: {line: 'RowTwo'}}]}, 350));
    draft.screens.push({id: 'popup', name: 'Choice popup', kind: 'popup', width: 400, height: 300, parameters: {line: 'Popup'}, components: [dropdown(), component('quantity', 'numberInput', {fieldKey: 'quantity', defaultValue: 0}), button()]});
    draft.screens[0].components.push(component('open-popup', 'button', {text: 'Open', action: 'openPopup', targetScreenId: 'popup', parameters: {line: '{line} popup'}}, 430));
    await save(); await publish();
    assert.equal((await action('Screen')).success, true); await action('Line1', {status: 400});
    assert.equal((await action('Instance', {instanceId: 'instance'})).success, true); await action('Screen', {instanceId: 'instance', status: 400});
    assert.equal((await action('RowOne', {instanceId: 'repeat', rowId: 'one'})).success, true); await action('RowOne', {instanceId: 'repeat', rowId: 'two', status: 400});
    const popup = {screen: 'popup', popupOrigin: {screenId: 'main', componentId: 'open-popup'}};
    assert.equal((await action('Screen popup', popup)).success, true); await action('Popup', {...popup, status: 400});
  });
  await test('portable project packages retain options-source configuration and selection mappings', async () => {
    const bytes = await request(route('/export'), {binary: true});
    const imported = await request('/api/projects/import', {method: 'POST', raw: bytes}); created.push(imported.id);
    const restored = await request(`/api/projects/${imported.id}/project`);
    assert.deepEqual(restored.screens[0].components[0].props.optionsSource, source);
    assert.deepEqual(restored.screens[0].components[0].props.selectionFields, {quantity: 'quantity'});
    assert.equal((await request(`/api/projects/${imported.id}/project/publication`)).published, false);
  });
} catch (error) { failure = error; }
finally {
  for (const id of created) {
    try { await request(`/api/projects/${id}/archive`, {method: 'POST', body: {archived: true}}); }
    catch (error) { failure ??= error; }
  }
}
if (failure) throw failure;
console.log(`${passed} query-control integration checks passed.`);
