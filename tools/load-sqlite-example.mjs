#!/usr/bin/env node
// Independently authored local application example. Existing resources are preserved.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const connection={id:'sqlite-workorders',name:'Work orders · SQLite',type:'sqlite',database:'workorders.db'};
const parameter=(name,type='string')=>({name,type});
const definitions=[
  {id:'orders-list',name:'Orders / List',kind:'query',sql:'SELECT id, work_order, machine, quantity, status, recorded_at, version FROM production_records ORDER BY id DESC LIMIT 200',parameters:[]},
  {id:'orders-active',name:'Orders / Active count',kind:'query',sql:"SELECT COUNT(*) AS active FROM production_records WHERE status <> 'complete'",parameters:[]},
  {id:'orders-create',name:'Orders / Create',kind:'update',sql:'INSERT INTO production_records (work_order, machine, quantity, status, recorded_at) VALUES (@work_order, @machine, @quantity, @status, @recorded_at)',parameters:[parameter('work_order'),parameter('machine'),parameter('quantity','int'),parameter('status'),parameter('recorded_at')]},
  {id:'orders-update',name:'Orders / Save changes',kind:'update',sql:'UPDATE production_records SET work_order=@work_order, machine=@machine, quantity=@quantity, status=@status, recorded_at=@recorded_at, version=version+1 WHERE id=@id AND version=@version',parameters:[parameter('work_order'),parameter('machine'),parameter('quantity','int'),parameter('status'),parameter('recorded_at'),parameter('id','int'),parameter('version','int')]},
];
const tagPath='[default]WorkOrders/ActiveCount';
const library=`from datetime import datetime, timezone

def values(data):
    order = str(data['work_order']).strip()
    machine = str(data['machine']).strip()
    quantity = data['quantity']
    if not order or not machine:
        raise ValueError('Work order and machine are required.')
    if isinstance(quantity, bool) or not isinstance(quantity, (int, float)) or quantity != int(quantity) or quantity < 0 or quantity > 1000000:
        raise ValueError('Quantity must be a whole number from 0 to 1,000,000.')
    if data['status'] not in ('queued', 'running', 'complete'):
        raise ValueError('Choose a valid status.')
    return dict(work_order=order, machine=machine, quantity=int(quantity), status=data['status'], recorded_at=datetime.now(timezone.utc).isoformat(timespec='seconds'))

def create(data):
    count = system.db.runNamedQuery('orders-create', values(data))
    return {'message': 'Work order created.' if count == 1 else 'No order was created.'}

def update(data):
    changes = values(data)
    for key in ('id', 'version'):
        value = data[key]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 1 or value > 2147483647 or value != int(value):
            raise ValueError('Select an order with a valid whole-number ID and revision first.')
        changes[key] = int(value)
    count = system.db.runNamedQuery('orders-update', changes)
    if count != 1:
        raise ValueError('This order changed since you selected it. Refresh the table, select it again, then save.')
    return {'message': 'Changes saved. Select the refreshed row to make another edit.'}
`;
const resources=[
  {id:'orders-library',name:'workorders',type:'library',enabled:true,code:library,parameters:{}},
  {id:'orders-startup',name:'Order application startup',type:'gateway',event:'startup',enabled:true,code:"print('Work order application ready. SQLite connection is local to this gateway.')",parameters:{}},
  {id:'orders-counter',name:'Refresh active order count',type:'gateway',event:'timer',intervalMs:5000,enabled:true,code:`rows = system.db.runNamedQuery('orders-active')\ncount = rows.getValueAt(0, 'active')\nsystem.tag.writeBlocking(['${tagPath}'], [count])\nresult = count`,parameters:{}},
  {id:'orders-browser',name:'Operator session welcome',type:'client',event:'startup',enabled:true,code:"session.openedAt = new Date().toISOString();\napp.notify('Work orders are ready. Select a row to edit, or open New work order.');",parameters:{}},
];
const c=(id,type,x,y,width,height,props)=>({id,type,x,y,width,height,props});
const label=(id,text,x,y,width=1120,size=16)=>c(id,'label',x,y,width,40,{text,fontSize:size});
const field=(key,text,x,y,width=256,type='textInput',extra={})=>c(key,type,x,y,width,84,{text,fieldKey:key,defaultValue:type==='numberInput'?0:'',...extra});
const statusOptions=['queued','running','complete'].map(value=>({value,label:value[0].toUpperCase()+value.slice(1)}));
const action=(id,text,x,y,width,method)=>c(id,'button',x,y,width,56,{text,action:'script',script:`from project import workorders\nresult = workorders.${method}(inputs)`});
const screen={id:'sqlite-workorders',name:'Work orders',width:1200,height:940,components:[
  label('heading','Work orders',32,24,900,32),
  label('description','Select a row, edit the form, then save. Changes persist in the local SQLite database.',32,75),
  c('orders','table',32,137,1136,315,{text:'Production orders',queryId:'orders-list',rowKey:'id',selectionFields:{id:'id',version:'version',work_order:'work_order',machine:'machine',quantity:'quantity',status:'status'}}),
  label('edit-heading','Edit selected order',32,476,600,22),
  field('work_order','Work order',32,532,348),field('machine','Machine',404,532,348),field('quantity','Quantity',776,532,392,'numberInput',{min:0,max:1000000,step:1,defaultValue:100}),
  field('status','Status',32,642,348,'select',{defaultValue:'queued',options:statusOptions}),field('id','Selected record ID',404,642,166,'numberInput',{defaultValue:0,min:0,max:2147483647,step:1}),field('version','Selected revision',594,642,158,'numberInput',{defaultValue:0,min:0,max:2147483647,step:1}),
  action('save','Save changes',776,656,392,'update'),
  c('active','value',32,770,348,132,{text:'Active orders',tagPath,unit:'orders'}),
  label('conflict-note','Revision checks prevent overwriting an order changed by another operator.',404,778,744,15),
  c('new','button',776,846,392,56,{text:'New work order',action:'navigate',targetScreenId:'sqlite-new-order'}),
]};
const createScreen={id:'sqlite-new-order',name:'New work order',width:1200,height:820,components:[
  label('heading','New work order',40,30,1100,32),label('description','Create a production record with a parameterized database action.',40,84),
  field('work_order','Work order',40,165,500,'textInput',{defaultValue:'WO-1004'}),field('machine','Machine',40,275,500,'textInput',{defaultValue:'Assembly-04'}),field('quantity','Quantity',40,385,240,'spinner',{defaultValue:100,min:0,max:1000000,step:1}),field('status','Status',304,385,236,'select',{defaultValue:'queued',options:statusOptions}),
  action('create','Create order',40,508,500,'create'),
  c('latest','table',580,165,580,500,{text:'Latest orders',queryId:'orders-list',rowKey:'id'}),
  c('back','button',40,610,500,56,{text:'Back to work orders',action:'navigate',targetScreenId:'sqlite-workorders'}),
  label('note','Synthetic example data · local database · no cloud or SQL Server required',40,730,1100,15),
]};

const semanticProps = ['tagPath','script','action','targetScreenId','parameters','queryId','rowKey','selectionFields','fieldKey','defaultValue','min','max','step','options','templateId','rows','assetId','icon','src','url'];
export function sqliteExamplePlan() {
  return structuredClone({connection,queries:definitions.map(definition=>({...definition,connectionId:connection.id})),
    resources,screens:[screen,createScreen],tag:{path:tagPath,kind:'memory',dataType:'Int32',value:0,enabled:true}});
}
function sameSubset(actual, expected) {
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((value,index) => sameSubset(actual[index],value));
  if (expected !== null && typeof expected === 'object') return actual !== null && typeof actual === 'object' && !Array.isArray(actual) && Object.entries(expected).every(([key,value]) => Object.hasOwn(actual,key) && sameSubset(actual[key],value));
  return Object.is(actual,expected);
}
function queryContract(query) {
  return {id:query.id,name:query.name,connectionId:query.connectionId,kind:query.kind ?? 'query',sql:query.sql,
    parameters:(query.parameters ?? []).map(item => ({name:item.name,type:item.type ?? 'string'})).sort((a,b)=>a.name.localeCompare(b.name))};
}
function scriptContract(resource) {
  return {id:resource.id,name:resource.name,type:resource.type,enabled:resource.enabled ?? resource.type === 'library',
    code:resource.code?.replaceAll('\r\n','\n'),parameters:resource.parameters ?? {},
    ...(resource.type === 'library' ? {} : {event:resource.event ?? 'startup'}),
    ...(resource.type === 'gateway' && resource.event === 'timer' ? {intervalMs:resource.intervalMs ?? 1000} : {})};
}

// Pure preflight is exported for fixture checks. It performs no I/O and reports
// only resource identities, never SQL, code, connection values or credentials.
export function preflightSqliteExample({project,queries,scripts,connections,tags}) {
  const conflict = (kind,id) => { throw new Error(`SQLite example conflicts with existing ${kind} '${id}'. Rename the existing resource or use a fresh development gateway; nothing was changed.`); };
  const existing=connections.find(item=>item.id===connection.id);
  if (existing && (existing.type !== connection.type || existing.database !== connection.database)) conflict('connection',connection.id);
  for (const definition of definitions) {
    const matches=queries.filter(item=>item.id===definition.id);
    if (matches.length > 1) conflict('query',definition.id);
    if (matches.length) {
      try { assert.deepEqual(queryContract(matches[0]),queryContract({...definition,connectionId:connection.id})); }
      catch { conflict('query',definition.id); }
    }
  }
  for (const resource of resources) {
    const matches=scripts.resources.filter(item=>item.id===resource.id);
    if (matches.length > 1 || scripts.resources.some(item=>item.name===resource.name && item.id!==resource.id)) conflict('script resource',resource.id);
    if (matches.length) {
      try { assert.deepEqual(scriptContract(matches[0]),scriptContract(resource)); }
      catch { conflict('script resource',resource.id); }
    }
  }
  for (const expected of [screen,createScreen]) {
    const matches=project.screens.filter(item=>item.id===expected.id);
    if (matches.length > 1) conflict('screen',expected.id);
    if (!matches.length) continue;
    const actual=matches[0];
    if (!sameSubset(actual,expected) || (Object.hasOwn(actual,'kind') && actual.kind !== 'screen') ||
        (Object.hasOwn(actual,'parameters') && (!actual.parameters || Array.isArray(actual.parameters) || typeof actual.parameters !== 'object' || Object.keys(actual.parameters).length))) conflict('screen',expected.id);
    for (let index=0;index<expected.components.length;index++) {
      const actualProps=actual.components[index].props, expectedProps=expected.components[index].props;
      if (semanticProps.some(key=>Object.hasOwn(actualProps,key) && !Object.hasOwn(expectedProps,key) &&
          // Empty unbound paths are a harmless editor default.
          !(key==='tagPath' && actualProps[key]===''))) conflict('screen',expected.id);
    }
  }
  const tag=tags.find(item=>item.path===tagPath);
  if (tag && (tag.kind!=='memory' || tag.dataType!=='Int32' || tag.enabled===false)) conflict('tag',tagPath);
  assert.ok(project.screens.length + [screen,createScreen].filter(item=>!project.screens.some(saved=>saved.id===item.id)).length <= 100,'The SQLite example would exceed the 100-screen limit; nothing was changed.');
  assert.ok(scripts.resources.length + resources.filter(item=>!scripts.resources.some(saved=>saved.id===item.id)).length <= 100,'The SQLite example would exceed the 100-script limit; nothing was changed.');
}

async function main() {
  const args=process.argv.slice(2), positional=args.filter(arg=>!arg.startsWith('--'));
  assert.ok(positional.length<=1 && args.filter(arg=>arg.startsWith('--')).every(arg=>arg==='--publish'),'Pass an optional local gateway URL and --publish only.');
  const base=new URL(positional[0] || 'http://127.0.0.1:5090'), publish=args.includes('--publish');
  assert.ok(base.protocol==='http:' && ['localhost','127.0.0.1'].includes(base.hostname) && ['5090','5091'].includes(base.port) && base.pathname==='/' && !base.username && !base.password && !base.search && !base.hash);
  async function api(path,method='GET',body) {
    const response=await fetch(new URL('/api'+path,base),{method,headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(30000),redirect:'error'});
    const text=await response.text();
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text.slice(0,400)}`);
    return text ? JSON.parse(text) : null;
  }
  const [project,queries,scripts,connections,tags]=await Promise.all(['/project','/queries','/scripts/resources','/connections','/tag-definitions'].map(path=>api(path)));
  preflightSqliteExample({project,queries,scripts,connections,tags});
  const backups=new URL('../.data/example-backups/',import.meta.url); await mkdir(backups,{recursive:true});
  await writeFile(new URL(`${Date.now()}-sqlite-workorders.json`,backups),JSON.stringify({project,queries,scripts},null,2),{flag:'wx'});
  if (!connections.some(item=>item.id===connection.id)) await api('/connections','POST',connection);
  const tested=await api(`/connections/${connection.id}/test`,'POST');
  if (!tested.success) {
    const created=await api(`/connections/${connection.id}/database`,'POST',{initializeSampleData:true});
    assert.ok(created.success,created.message);
  }
  const schema=await api(`/connections/${connection.id}/schema`), table=schema.find(item=>item.name==='production_records');
  const columns={id:'INTEGER',work_order:'TEXT',machine:'TEXT',quantity:'INTEGER',status:'TEXT',recorded_at:'TEXT',version:'INTEGER'};
  assert.ok(table && Object.entries(columns).every(([name,type])=>table.columns.some(column=>column.name===name && column.dataType.toUpperCase()===type)) && table.columns.some(column=>column.name==='id' && column.primaryKey),'Expected example schema; existing database preserved.');
  for(const definition of definitions) if (!queries.some(item=>item.id===definition.id)) await api(`/queries/${definition.id}`,'PUT',{...definition,connectionId:connection.id});
  if (!tags.some(item=>item.path===tagPath)) await api('/tags','POST',{path:tagPath,kind:'memory',dataType:'Int32',value:0,enabled:true});
  const nextScripts=structuredClone(scripts);
  for(const resource of resources) if (!nextScripts.resources.some(item=>item.id===resource.id)) nextScripts.resources.push(resource);
  const savedScripts=nextScripts.resources.length!==scripts.resources.length ? await api('/scripts/resources','PUT',nextScripts) : scripts;
  const next=structuredClone(project); let added=0;
  for (const item of [screen,createScreen]) if (!next.screens.some(saved=>saved.id===item.id)) { next.screens.push(item); added++; }
  const saved=added ? await api('/project','PUT',next) : project;
  if (publish) {
    await api('/scripts/publish','POST',{revision:savedScripts.revision});
    await api('/project/publish','POST',{revision:saved.revision});
  }
  console.log(`SQLite workorders.db ready. Added ${added} screens; existing resources preserved. ${publish?'Published':'Draft saved'}: ${base}runtime`);
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) await main();
