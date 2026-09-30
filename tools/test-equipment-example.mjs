#!/usr/bin/env node
// Pure fixture and mocked-transport checks; never contacts a running gateway.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { equipmentExamplePlan, preflightEquipmentExample, validateEquipmentSchema } from './load-equipment-example.mjs';

const plan = equipmentExamplePlan();
const snapshot = { project: { revision: 1, screens: [plan.screen] }, queries: plan.queries,
  connections: [{ id: plan.connectionId, type: 'sqlite', database: 'workorders.db' }], tags: plan.tags };
const schema = [{ name: 'production_records', columns: Object.entries({ id: 'INTEGER', work_order: 'TEXT', machine: 'TEXT', quantity: 'INTEGER', status: 'TEXT', recorded_at: 'TEXT', version: 'INTEGER' }).map(([name, dataType]) => ({ name, dataType, primaryKey: name === 'id' })) }];
let passed = 0;
function check(name, run) { run(); passed++; console.log(`PASS ${name}`); }
function rejects(name, edit) {
  check(name, () => { const next = structuredClone(snapshot); edit(next); assert.throws(() => preflightEquipmentExample(next), /conflicts|requires|limit/); });
}
check('an unchanged authored installation is reusable without modifying its snapshot', () => {
  const before = structuredClone(snapshot); preflightEquipmentExample(snapshot); assert.deepEqual(snapshot, before);
});
check('a project with the prerequisite connection accepts the additive plan', () => preflightEquipmentExample({ ...snapshot, project: { screens: [] }, queries: [], tags: [] }));
check('the existing example schema is accepted', () => validateEquipmentSchema(schema));
check('missing or incompatible schema fails before database changes', () => {
  assert.throws(() => validateEquipmentSchema([]), /never creates or replaces/);
  const wrong = structuredClone(schema); wrong[0].columns.find(item => item.name === 'version').dataType = 'TEXT';
  assert.throws(() => validateEquipmentSchema(wrong), /Expected/);
  const noKey = structuredClone(schema); noKey[0].columns[0].primaryKey = false;
  assert.throws(() => validateEquipmentSchema(noKey), /Expected/);
});
rejects('the prerequisite SQLite connection is required', next => { next.connections = []; });
rejects('an incompatible connection ID is never repointed', next => { next.connections[0].database = 'other.db'; });
rejects('duplicate connection IDs are rejected', next => { next.connections.push(structuredClone(next.connections[0])); });
for (const [name, patch] of Object.entries({ connection: { connectionId: 'other' }, kind: { kind: 'query' }, statement: { sql: 'DELETE FROM other_records' }, parameters: { parameters: [] } }))
  rejects(`reserved query ${name} changes are rejected`, next => Object.assign(next.queries.find(item => item.id === 'equipment-save'), patch));
rejects('duplicate reserved query IDs are rejected', next => { next.queries.push(structuredClone(next.queries[0])); });
rejects('query defaults that alter the contract are rejected', next => { next.queries.find(item => item.id === 'equipment-save').parameters[0].defaultValue = 'Other'; });
rejects('changed screen Python source is rejected', next => { next.project.screens[0].components.find(item => item.id === 'save').props.script = 'result = 0'; });
rejects('extra selection mappings are rejected', next => { next.project.screens[0].components.find(item => item.id === 'selected_record').props.selectionFields.unrelated = 'work_order'; });
rejects('extra bindings are rejected', next => { next.project.screens[0].components.find(item => item.id === 'load').props.bindings.visible = { expression: 'false', references: {} }; });
rejects('injected event handlers are rejected', next => { next.project.screens[0].components.find(item => item.id === 'quantity').props.events = { change: 'app.notify("different");' }; });
rejects('different screen context is rejected', next => { next.project.screens[0].parameters = { machine: 'Different' }; });
rejects('disabled synthetic tag definitions are rejected', next => { next.tags[0].enabled = false; });
rejects('external tags cannot occupy a synthetic tag path', next => { next.tags[0].kind = 'opc'; });
rejects('screen capacity is checked before mutation', next => { next.project.screens = Array.from({ length: 100 }, (_, id) => ({ id: String(id) })); });
check('additive equipment tags fit exactly at the 10,000-tag boundary', () => {
  const tags = Array.from({ length: 10_000 - plan.tags.length }, (_, index) => ({ path: `[default]CapacityFixture/T${index}`, kind: 'memory', dataType: 'Int32', value: 0 }));
  preflightEquipmentExample({ ...snapshot, tags });
  assert.throws(() => preflightEquipmentExample({ ...snapshot, tags: [...tags, { path: '[default]CapacityFixture/Extra' }] }), /10,000-tag limit/);
});
check('harmless styling, metadata, and existing synthetic values are preserved', () => {
  const next = structuredClone(snapshot);
  next.project.screens[0].kind = 'screen'; next.project.screens[0].parameters = {};
  next.project.screens[0].components[0].props.color = '#123456';
  next.project.screens[0].components.find(item => item.id === 'quantity').props.tagPath = '';
  next.queries[0].description = 'Author metadata'; delete next.queries[0].kind;
  next.queries.find(item => item.id === 'equipment-save').parameters.reverse();
  next.tags[0].value = 44; next.connections[0].status = 'connected';
  preflightEquipmentExample(next);
});
for (const mode of ['collision', 'schema']) check(`the real loader stops on ${mode} before any HTTP mutation`, () => {
  const fixture = structuredClone(snapshot);
  if (mode === 'collision') fixture.queries[0].connectionId = 'other';
  const module = fileURLToPath(new URL('./load-equipment-example.mjs', import.meta.url));
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import {readFileSync} from 'node:fs';
    import {pathToFileURL} from 'node:url';
    const {fixture,module,mode}=JSON.parse(readFileSync(0,'utf8'));
    const replies={'/api/projects/default/project':fixture.project,'/api/projects/default/queries':fixture.queries,
      '/api/connections':fixture.connections,'/api/tag-definitions':fixture.tags,'/api/connections/sqlite-workorders/schema':[]};
    let reads=0,writes=0;
    globalThis.fetch=async(url,options={})=>{
      if((options.method??'GET')!=='GET'){writes++;throw new Error('Unexpected HTTP mutation.');}
      reads++; const path=new URL(url).pathname; assert.ok(Object.hasOwn(replies,path));
      return new Response(JSON.stringify(replies[path]),{status:200});
    };
    process.argv=[process.execPath,module,'http://127.0.0.1:5091'];
    await assert.rejects(import(pathToFileURL(module)),mode==='collision'?/conflicts with existing query/:/Expected the existing/);
    assert.equal(reads,mode==='collision'?4:5);assert.equal(writes,0);
  `], { input: JSON.stringify({ fixture, module, mode }), encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
});
check('inline Python rejects invalid identity, validation failures, and stale revisions without unsafe SQL', () => {
  const executable = process.env.SPARKSTUDIO_PYTHON || (process.platform === 'win32' ? fileURLToPath(new URL('../runtimes/python/windows-x64/python.exe', import.meta.url)) : 'python3');
  const child = spawnSync(executable, ['-I', '-c', `
import json, sys, types
code=json.load(sys.stdin)['code']
calls=[]
affected=1
def query(name, parameters):
    calls.append((name, parameters))
    return affected
def run(data):
    scope={'system':types.SimpleNamespace(db=types.SimpleNamespace(runNamedQuery=query)),'inputs':data}
    exec(code,scope)
    return scope['result']
valid={'selected_record':'1','id':1,'version':1,'work_order':' Demo ','machine':' Press01 ','quantity':0,'status':'queued'}
assert 'Changes saved' in run(valid)['message']
assert calls[-1][0]=='equipment-save' and calls[-1][1]['quantity']==0
assert calls[-1][1]['work_order']=='Demo' and calls[-1][1]['machine']=='Press01'
run(dict(valid,work_order="'; DROP TABLE production_records;--"))
assert calls[-1][1]['work_order']=="'; DROP TABLE production_records;--"
before=len(calls)
for patch in [dict(selected_record=''),dict(selected_record='2'),dict(selected_record=1),dict(id=1.5),dict(id=0),dict(id=True),dict(version=0),dict(version=2147483648),dict(quantity=-1),dict(quantity=1.25),dict(quantity=True),dict(quantity=1000001),dict(work_order='  '),dict(machine=''),dict(machine='x'*201),dict(status='bad')]:
    try:
        run(dict(valid,**patch))
        raise AssertionError('Invalid form was accepted')
    except ValueError:
        pass
assert len(calls)==before
affected=0
try:
    run(valid)
    raise AssertionError('Stale version was accepted')
except ValueError as error:
    assert 'changed after selection' in str(error)
assert len(calls)==before+1
`], { input: JSON.stringify({ code: plan.screen.components.find(item => item.id === 'save').props.script }), encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
});
console.log(`${passed} equipment example preflight checks passed.`);
