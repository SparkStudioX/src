#!/usr/bin/env node
// Independently authored equipment form over the existing local SQLite example.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const connectionId = 'sqlite-workorders';
const parameter = (name, type = 'string') => ({ name, type });
const queries = [
  {
    id: 'equipment-options', name: 'Equipment / Record choices', kind: 'query', connectionId,
    sql: "SELECT CAST(id AS TEXT) AS record_id, SUBSTR(machine || ' / ' || work_order, 1, 200) AS equipment_label, id, version, work_order, machine, quantity, status FROM production_records ORDER BY machine, id LIMIT 100",
    parameters: [],
  },
  {
    id: 'equipment-list', name: 'Equipment / Saved records', kind: 'query', connectionId,
    sql: 'SELECT id, work_order, machine, quantity, status, version, recorded_at FROM production_records ORDER BY machine, id LIMIT 100',
    parameters: [],
  },
  {
    id: 'equipment-save', name: 'Equipment / Save selected record', kind: 'update', connectionId,
    sql: 'UPDATE production_records SET work_order=@work_order, machine=@machine, quantity=@quantity, status=@status, recorded_at=@recorded_at, version=version+1 WHERE id=@id AND version=@version',
    parameters: [parameter('work_order'), parameter('machine'), parameter('quantity', 'int'), parameter('status'), parameter('recorded_at'), parameter('id', 'int'), parameter('version', 'int')],
  },
];
const saveScript = `from datetime import datetime, timezone

def whole_number(key, minimum, maximum):
    value = inputs[key]
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value != int(value) or value < minimum or value > maximum:
        raise ValueError(key + ' must be a whole number from ' + str(minimum) + ' to ' + str(maximum) + '.')
    return int(value)

record_id = whole_number('id', 1, 2147483647)
version = whole_number('version', 1, 2147483647)
if inputs['selected_record'] != str(record_id):
    raise ValueError('Choose an equipment record before saving. Its selected ID must match the form.')
work_order = inputs['work_order'].strip()
machine = inputs['machine'].strip()
if not work_order or not machine:
    raise ValueError('Work order and machine are required.')
if len(work_order) > 200 or len(machine) > 200:
    raise ValueError('Work order and machine must be 200 characters or fewer.')
status = inputs['status']
if status not in ('queued', 'running', 'complete'):
    raise ValueError('Choose a valid status.')
changes = dict(id=record_id, version=version, work_order=work_order, machine=machine,
               quantity=whole_number('quantity', 0, 1000000), status=status,
               recorded_at=datetime.now(timezone.utc).isoformat(timespec='seconds'))
count = system.db.runNamedQuery('equipment-save', changes)
if count != 1:
    raise ValueError('This record changed after selection. Use Reload selected record, review your changes, and save.')
result = {'message': 'Changes saved. The records and choices refresh; use Reload selected record before another edit.'}
`;
const c = (id, type, x, y, width, height, props) => ({ id, type, x, y, width, height, props });
const label = (id, text, x, y, width, height = 40, fontSize = 16) => c(id, 'label', x, y, width, height, { text, fontSize });
const input = (id, type, text, x, y, width, props = {}) => c(id, type, x, y, width, 86, { text, fieldKey: id, defaultValue: type === 'numberInput' ? 0 : '', ...props });
const statusOptions = ['queued', 'running', 'complete'].map(value => ({ value, label: value[0].toUpperCase() + value.slice(1) }));
const machineReference = { machine: { kind: 'input', key: 'machine' } };
const screen = {
  id: 'equipment-workbench', name: 'Equipment workbench', width: 1200, height: 1040,
  components: [
    label('heading', 'Equipment workbench', 32, 22, 1120, 44, 32),
    label('description', 'Synthetic equipment example · choose a record, edit the form, then save to the local SQLite database.', 32, 74, 1136, 36, 15),
    input('selected_record', 'select', 'Equipment / work order', 32, 124, 740, {
      optionsSource: { queryId: 'equipment-options', valueColumn: 'record_id', labelColumn: 'equipment_label' },
      selectionFields: { id: 'id', version: 'version', work_order: 'work_order', machine: 'machine', quantity: 'quantity', status: 'status' },
    }),
    input('work_order', 'textInput', 'Work order', 32, 252, 354),
    input('machine', 'textInput', 'Machine', 418, 252, 354),
    input('quantity', 'numberInput', 'Quantity', 32, 370, 224, { min: 0, max: 1000000, step: 1 }),
    input('status', 'select', 'Status', 282, 370, 236, { defaultValue: 'queued', options: statusOptions }),
    input('id', 'numberInput', 'Record ID', 546, 370, 104, { min: 0, max: 2147483647, step: 1, enabled: false }),
    input('version', 'numberInput', 'Revision', 676, 370, 96, { min: 0, max: 2147483647, step: 1, enabled: false }),
    c('save', 'button', 32, 490, 354, 56, { text: 'Save selected record', action: 'script', script: saveScript }),
    label('save-note', 'Use Reload selected record after saving to load its new revision.', 418, 480, 354, 80, 15),
    c('load', 'gauge', 808, 124, 360, 258, {
      text: 'Synthetic machine load', tagPath: '[default]EquipmentDemo/Unselected/Load', unit: '%', min: 0, max: 100,
      bindings: { tagPath: { expression: "'[default]EquipmentDemo/' + machine + '/Load'", references: machineReference } },
    }),
    label('selected-machine', 'Choose an equipment record', 808, 405, 360, 66, 17),
    label('load-note', 'Fixed memory values for Press01–03. Other machine names show unknown tag quality.', 808, 480, 360, 94, 14),
    label('records-heading', 'Saved production records', 32, 601, 1136, 40, 22),
    c('records', 'table', 32, 655, 1136, 308, { text: 'Saved records · refreshes after a successful save', queryId: 'equipment-list', rowKey: 'id' }),
    label('footer', 'Synthetic example · no equipment commands · query choices show the first 100 records ordered by machine and ID.', 32, 986, 1136, 36, 14),
  ],
};
screen.components.find(item => item.id === 'selected_record').height = 114;
screen.components.find(item => item.id === 'selected-machine').props.bindings = {
  text: { expression: "machine == '' ? 'Choose an equipment record' : 'Selected machine: ' + machine", references: machineReference },
};
const tags = [['Press01', 28], ['Press02', 64], ['Press03', 91]].map(([machine, value]) => ({
  path: `[default]EquipmentDemo/${machine}/Load`, kind: 'memory', dataType: 'Int32', value, enabled: true,
}));
const semanticProps = ['tagPath', 'script', 'action', 'targetScreenId', 'parameters', 'queryId', 'optionsSource', 'rowKey', 'selectionFields', 'fieldKey', 'defaultValue', 'min', 'max', 'step', 'options', 'templateId', 'rows', 'events', 'bindings', 'customProperties', 'enabled', 'visible', 'assetId', 'icon', 'src', 'url'];

export function equipmentExamplePlan() { return structuredClone({ connectionId, queries, screen, tags }); }

function sameSubset(actual, expected) {
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((value, index) => sameSubset(actual[index], value));
  if (expected !== null && typeof expected === 'object') return actual !== null && typeof actual === 'object' && !Array.isArray(actual) && Object.entries(expected).every(([key, value]) => Object.hasOwn(actual, key) && sameSubset(actual[key], value));
  return Object.is(actual, expected);
}
function queryContract(query) {
  return { id: query.id, name: query.name, connectionId: query.connectionId, kind: query.kind ?? 'query', sql: query.sql,
    parameters: (query.parameters ?? []).map(item => ({ name: item.name, type: item.type ?? 'string', ...(Object.hasOwn(item, 'defaultValue') ? { defaultValue: item.defaultValue } : {}) })).sort((a, b) => a.name.localeCompare(b.name)) };
}

// Pure preflight rejects collisions without changing gateway or database state.
export function preflightEquipmentExample({ project, queries: existingQueries, connections, tags: existingTags }) {
  const conflict = (kind, id) => { throw new Error(`Equipment example conflicts with existing ${kind} '${id}'. Rename the existing resource or use a fresh development project; nothing was changed.`); };
  const matches = connections.filter(item => item.id === connectionId);
  assert.ok(matches.length, 'The equipment example requires the SQLite example connection. Run node tools/load-sqlite-example.mjs first; nothing was changed.');
  if (matches.length !== 1 || matches[0].type !== 'sqlite' || matches[0].database !== 'workorders.db') conflict('connection', connectionId);
  for (const expected of queries) {
    const found = existingQueries.filter(item => item.id === expected.id);
    if (found.length > 1) conflict('query', expected.id);
    if (found.length) {
      try { assert.deepEqual(queryContract(found[0]), queryContract(expected)); }
      catch { conflict('query', expected.id); }
    }
  }
  const found = project.screens.filter(item => item.id === screen.id);
  if (found.length > 1) conflict('screen', screen.id);
  if (found.length) {
    const actual = found[0];
    if (!sameSubset(actual, screen) || (Object.hasOwn(actual, 'kind') && actual.kind !== 'screen') ||
        (Object.hasOwn(actual, 'parameters') && (!actual.parameters || Array.isArray(actual.parameters) || typeof actual.parameters !== 'object' || Object.keys(actual.parameters).length))) conflict('screen', screen.id);
    for (let index = 0; index < screen.components.length; index++) {
      const actualProps = actual.components[index].props, expectedProps = screen.components[index].props;
      if (semanticProps.some(key => Object.hasOwn(actualProps, key) && !Object.hasOwn(expectedProps, key) && !(key === 'tagPath' && actualProps[key] === ''))) conflict('screen', screen.id);
      // Additional bindings, event handlers, or mappings alter a reused screen's behavior.
      for (const key of ['bindings', 'events', 'selectionFields', 'optionsSource', 'customProperties']) if (Object.hasOwn(expectedProps, key)) {
        try { assert.deepEqual(actualProps[key], expectedProps[key]); }
        catch { conflict('screen', screen.id); }
      }
    }
  }
  for (const expected of tags) {
    const found = existingTags.filter(item => item.path === expected.path);
    if (found.length > 1 || (found.length && (found[0].kind !== 'memory' || found[0].dataType !== 'Int32' || found[0].enabled === false))) conflict('tag', expected.path);
  }
  assert.ok(project.screens.length + (found.length ? 0 : 1) <= 100, 'The equipment example would exceed the 100-screen limit; nothing was changed.');
  assert.ok(existingTags.length + tags.filter(item => !existingTags.some(saved => saved.path === item.path)).length <= 1000, 'The equipment example would exceed the 1000-tag limit; nothing was changed.');
}

export function validateEquipmentSchema(schema) {
  const table = schema.find(item => item.name === 'production_records');
  const columns = { id: 'INTEGER', work_order: 'TEXT', machine: 'TEXT', quantity: 'INTEGER', status: 'TEXT', recorded_at: 'TEXT', version: 'INTEGER' };
  assert.ok(table && Object.entries(columns).every(([name, type]) => table.columns.some(column => column.name === name && column.dataType.toUpperCase() === type)) && table.columns.some(column => column.name === 'id' && column.primaryKey),
    'Expected the existing SQLite example production_records schema in workorders.db. Run the SQLite example loader first; the equipment loader never creates or replaces a database. Nothing was changed.');
}

async function main() {
  const args = process.argv.slice(2), positional = args.filter(arg => !arg.startsWith('--'));
  const projectOptions = args.filter(arg => arg.startsWith('--project='));
  assert.ok(positional.length <= 1 && projectOptions.length <= 1 && args.filter(arg => arg.startsWith('--')).every(arg => arg === '--publish' || /^--project=[a-z][a-z0-9-]{0,63}$/.test(arg)),
    'Pass an optional local gateway URL, --project=<id>, and --publish only.');
  const base = new URL(positional[0] || 'http://127.0.0.1:5090'), publish = args.includes('--publish');
  const projectId = projectOptions[0]?.slice('--project='.length) || 'default';
  assert.ok(base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname) && ['5090', '5091'].includes(base.port) && base.pathname === '/' && !base.username && !base.password && !base.search && !base.hash,
    'Use a local development gateway on port 5090 or 5091.');
  const projectPrefix = `/projects/${projectId}`;
  async function api(path, method = 'GET', body, shared = false) {
    const response = await fetch(new URL('/api' + (shared ? '' : projectPrefix) + path, base), { method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000), redirect: 'error' });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 400)}`);
    return text ? JSON.parse(text) : null;
  }
  const [project, existingQueries, connections, existingTags] = await Promise.all([
    api('/project'), api('/queries'), api('/connections', 'GET', undefined, true), api('/tag-definitions', 'GET', undefined, true),
  ]);
  preflightEquipmentExample({ project, queries: existingQueries, connections, tags: existingTags });
  validateEquipmentSchema(await api(`/connections/${connectionId}/schema`, 'GET', undefined, true));
  const backups = new URL('../.data/example-backups/', import.meta.url);
  await mkdir(backups, { recursive: true });
  await writeFile(new URL(`${Date.now()}-${projectId}-equipment-workbench.json`, backups), JSON.stringify({ project, queries: existingQueries }, null, 2), { flag: 'wx' });
  for (const query of queries) if (!existingQueries.some(item => item.id === query.id)) await api(`/queries/${query.id}`, 'PUT', query);
  for (const tag of tags) if (!existingTags.some(item => item.path === tag.path)) await api('/tags', 'POST', tag, true);
  const next = structuredClone(project), added = !next.screens.some(item => item.id === screen.id);
  if (added) next.screens.push(screen);
  const saved = added ? await api('/project', 'PUT', next) : project;
  if (publish) await api('/project/publish', 'POST', { revision: saved.revision });
  console.log(`Equipment workbench ${added ? 'added' : 'already present'}. Existing resources and database preserved. ${publish ? 'Published' : 'Draft saved'}: ${new URL(`/runtime/${projectId}`, base)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
