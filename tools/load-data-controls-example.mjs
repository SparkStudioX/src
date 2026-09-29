#!/usr/bin/env node
// Create a separate, independently authored application using synthetic managed SQLite data.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const args=process.argv.slice(2);
assert.ok(args.length<=1,'Use an optional local gateway URL.');
const base=new URL(args[0]??'http://127.0.0.1:5090');
assert.equal(base.protocol,'http:');
assert.ok(['127.0.0.1','localhost'].includes(base.hostname)&&['5090','5091'].includes(base.port),'Use a local development gateway on port5090 or5091.');
assert.ok(base.pathname==='/'&&!base.username&&!base.password&&!base.search&&!base.hash,'Use a plain local gateway URL.');
const example=JSON.parse(await readFile(new URL('../examples/data-controls.json',import.meta.url),'utf8'));
async function api(path,method='GET',body) {
 const response=await fetch(new URL('/api'+path,base),{method,headers:body===undefined?{}:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(30000)});
 const text=await response.text();if(!response.ok)throw Error(`${method} ${path}: ${response.status} ${text.slice(0,500)}`);
 return text?JSON.parse(text):null;
}
const catalog=await api('/projects');
assert.ok(!catalog.projects.some(p=>p.id==='data-workshop'||p.name===example.name),'Data workshop already exists. No changes made; open it from Projects.');
const connections=await api('/connections');
assert.ok(!connections.some(c=>c.id===example.connection.id||c.type==='sqlite'&&c.database===example.connection.database),'The reserved sample connection/database is already configured. No changes made.');
// Database creation is explicit and the gateway refuses to overwrite an existing file.
await api('/connections','POST',example.connection);
const database=await api(`/connections/${example.connection.id}/database`,'POST',{initializeSampleData:true});
assert.ok(database.success,database.message??'Could not create the sample database.');
const created=await api('/projects','POST',{name:example.name});
const route=`/projects/${created.id}`;
for(const query of example.queries)await api(`${route}/queries/${query.id}`,'PUT',query);
const draft=await api(`${route}/project`);
const saved=await api(`${route}/project`,'PUT',{...draft,screens:example.screens,templates:example.templates,navigation:example.navigation});
const published=await api(`${route}/project/publish`,'POST',{revision:saved.revision});
console.log(`Created ${example.name}, revision ${published.revision}, with synthetic SQLite records. Existing projects were not modified.`);
console.log(`Open ${new URL(`/runtime/${created.id}`,base)}`);
