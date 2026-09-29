#!/usr/bin/env node
// Pure fixture and mocked-transport checks. No running gateway is contacted.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { preflightSqliteExample, sqliteExamplePlan } from './load-sqlite-example.mjs';

const plan=sqliteExamplePlan();
const snapshot={project:{revision:1,screens:plan.screens},queries:plan.queries,scripts:{revision:1,resources:plan.resources},connections:[plan.connection],tags:[plan.tag]};
let passed=0;
function check(name,run) { run(); passed++; console.log(`PASS ${name}`); }
function rejects(name,edit) {
  check(name,()=>{const next=structuredClone(snapshot);edit(next);assert.throws(()=>preflightSqliteExample(next),/conflicts/);assert.deepEqual(snapshot.queries,plan.queries);});
}
check('an authored installation can be reused unchanged',()=>preflightSqliteExample(snapshot));
check('a fresh gateway plan does not require existing resources',()=>preflightSqliteExample({project:{screens:[]},queries:[],scripts:{resources:[]},connections:[],tags:[]}));
for (const [name,patch] of Object.entries({connection:{connectionId:'other-database'},kind:{kind:'query'},statement:{sql:'DELETE FROM unrelated_table'},parameters:{parameters:[]}}))
  rejects(`reserved query ${name} mismatch is rejected`,next=>Object.assign(next.queries.find(item=>item.id==='orders-update'),patch));
rejects('duplicate reserved query IDs are rejected',next=>next.queries.push(structuredClone(next.queries[0])));
rejects('reserved library code mismatch is rejected',next=>next.scripts.resources.find(item=>item.id==='orders-library').code+='\nresult = 0');
rejects('reserved library name under a different ID is rejected',next=>next.scripts.resources.push({id:'unrelated-module',type:'library',name:'workorders',code:'',enabled:true,parameters:{}}));
rejects('reserved gateway event changes are rejected',next=>next.scripts.resources.find(item=>item.id==='orders-counter').event='startup');
rejects('disabled reserved timer is rejected',next=>next.scripts.resources.find(item=>item.id==='orders-counter').enabled=false);
rejects('reserved screen script changes are rejected',next=>next.project.screens[0].components.find(item=>item.id==='save').props.script='result = 0');
rejects('unexpected form tag binding is rejected',next=>next.project.screens[0].components.find(item=>item.id==='quantity').props.tagPath='[default]Other');
rejects('unexpected screen context is rejected',next=>next.project.screens[0].parameters={target:'Other'});
rejects('malformed screen defaults are rejected',next=>next.project.screens[0].parameters=[]);
rejects('different database filename is rejected',next=>next.connections[0].database='other.db');
rejects('disabled counter tag is rejected',next=>next.tags[0].enabled=false);
check('harmless normalized defaults, metadata and styling are preserved',()=>{
  const next=structuredClone(snapshot);
  next.project.screens[0].kind='screen';next.project.screens[0].parameters={};
  next.project.screens[0].components[0].props.color='#123456';
  next.project.screens[0].components.find(item=>item.id==='quantity').props.tagPath='';
  delete next.queries[0].kind;
  next.queries[0].description='Saved author metadata';
  next.queries.find(item=>item.id==='orders-create').parameters.reverse();
  next.connections[0].status='connected';next.tags[0].value=17;
  preflightSqliteExample(next);
});
check('the real loader stops on a collision before any HTTP mutation',()=>{
  const fixture=structuredClone(snapshot);fixture.queries.find(item=>item.id==='orders-update').connectionId='other-database';
  const module=fileURLToPath(new URL('./load-sqlite-example.mjs',import.meta.url));
  const child=spawnSync(process.execPath,['--input-type=module','-e',`
    import assert from 'node:assert/strict';
    import {readFileSync} from 'node:fs';
    import {pathToFileURL} from 'node:url';
    const {fixture,module}=JSON.parse(readFileSync(0,'utf8'));
    const replies={'/api/project':fixture.project,'/api/queries':fixture.queries,'/api/scripts/resources':fixture.scripts,'/api/connections':fixture.connections,'/api/tag-definitions':fixture.tags};
    let reads=0,writes=0;
    globalThis.fetch=async(url,options={})=>{if((options.method??'GET')!=='GET'){writes++;throw new Error('Unexpected HTTP mutation.');}reads++;return new Response(JSON.stringify(replies[new URL(url).pathname]),{status:200});};
    process.argv=[process.execPath,module,'http://127.0.0.1:5091'];
    await assert.rejects(import(pathToFileURL(module)),/conflicts with existing query/);
    assert.equal(reads,5);assert.equal(writes,0);
  `],{input:JSON.stringify({fixture,module}),encoding:'utf8',windowsHide:true});
  assert.equal(child.status,0,child.stderr);
});
check('sample Python accepts zero quantity and rejects fractional or invalid record identities before SQL',()=>{
  const executable=process.env.SPARKSTUDIO_PYTHON || (process.platform==='win32' ? fileURLToPath(new URL('../runtimes/python/windows-x64/python.exe',import.meta.url)) : 'python3');
  const child=spawnSync(executable,['-I','-c',`
import json, sys, types
payload=json.load(sys.stdin)
calls=[]
def query(name, parameters):
    calls.append((name, parameters))
    return 1
namespace={'system':types.SimpleNamespace(db=types.SimpleNamespace(runNamedQuery=query))}
exec(payload['code'],namespace)
valid={'work_order':'Demo','machine':'Cell','quantity':0,'status':'queued','id':1,'version':1}
namespace['create'](valid)
assert calls[-1][1]['quantity']==0
namespace['update'](valid)
assert calls[-1][1]['id']==1 and calls[-1][1]['version']==1
before=len(calls)
for row_id, version in [(1.9,1),(1,1.9),(0,1),(1,0),(-1,1),(1,-1),(2147483648,1),(1,2147483648),(True,1),(1,False)]:
    try:
        namespace['update'](dict(valid,id=row_id,version=version))
        raise AssertionError('Invalid record identity accepted')
    except ValueError:
        pass
assert len(calls)==before
`],{input:JSON.stringify({code:plan.resources.find(resource=>resource.id==='orders-library').code}),encoding:'utf8',windowsHide:true});
  assert.equal(child.status,0,child.stderr || child.error?.message);
  for(const screen of plan.screens) assert.equal(screen.components.find(component=>component.id==='quantity').props.min,0);
});
console.log(`${passed} SQLite example preflight checks passed.`);
