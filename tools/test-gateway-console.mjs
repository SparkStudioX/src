// Run only against disposable test accounts on the isolated local gateway.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
const filename=path.resolve(process.env.SPARKSTUDIO_TEST_AUTH_FILE ?? '.data/test-evidence/security-test-accounts.json');
assert.ok(filename.startsWith(path.resolve('.data')+path.sep));
const accounts=JSON.parse(await fs.readFile(filename,'utf8')), base=new URL(accounts.baseUrl);
assert.ok(base.protocol==='http:' && ['127.0.0.1','localhost'].includes(base.hostname) && base.port==='5091' && base.pathname==='/');
async function login(account,audience='engineering') {
  const response=await fetch(new URL('/api/auth/login',base),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...account,audience})});
  assert.equal(response.status,200); const session=await response.json();
  return {cookie:response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; '),csrf:session.csrfToken,audience};
}
async function request(route,session,method='GET',body) {
  const headers=new Headers(); if(session){headers.set('Cookie',session.cookie);headers.set('X-SPARK-AUDIENCE',session.audience); if(method!=='GET')headers.set('X-SPARK-CSRF',session.csrf);}
  if(body!==undefined)headers.set('Content-Type','application/json');
  return fetch(new URL('/api'+route,base),{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
}
async function json(route,session){const r=await request(route,session);assert.equal(r.status,200);return r.json();}
const admin=await login(accounts.admin), operator=await login(accounts.admin,'operator'), designer=await login(accounts.designer);
let checks=0; const pass=name=>{checks++; console.log('PASS '+name);};
for(const route of ['/gateway/overview','/gateway/diagnostics','/gateway/support-snapshot']) {
  assert.equal((await request(route)).status,401);
  assert.equal((await request(route,operator)).status,401);
  assert.equal((await request(route,designer)).status,403);
}
pass('gateway console and support download enforce engineering administrator access');
const overview=await json('/gateway/overview',admin);
assert.ok(overview.projects.length); assert.ok(Number.isFinite(Date.parse(overview.observedAt)));
assert.ok(overview.sessions.some(item=>item.id===overview.currentSessionId));
for(const session of overview.sessions){assert.deepEqual(Object.keys(session).sort(),['id','username','displayName','audience','createdAt','lastActivityAt','expiresAt'].sort());assert.match(session.id,/^[a-f0-9]{32}$/);assert.ok(Date.parse(session.expiresAt)>Date.parse(session.createdAt));}
for(const connection of overview.connections)assert.deepEqual(Object.keys(connection).sort(),['id','name','type','status'].sort());
assert.ok(!JSON.stringify(overview).includes(admin.csrf));
pass('resource and session inventory has observation times and excludes credentials and authentication identifiers');
const second=await login(accounts.admin), secondOverview=await json('/gateway/overview',second);
assert.notEqual(secondOverview.currentSessionId,overview.currentSessionId);
assert.equal((await request(`/gateway/sessions/${secondOverview.currentSessionId}/revoke`,{...admin,csrf:''},'POST',{})).status,403);
assert.equal((await request(`/gateway/sessions/${secondOverview.currentSessionId}/revoke`,designer,'POST',{})).status,403);
assert.equal((await request(`/gateway/sessions/${secondOverview.currentSessionId}/revoke`,admin,'POST',{})).status,200);
assert.equal((await request('/gateway/overview',second)).status,401);
assert.equal((await request('/gateway/overview',admin)).status,200);
assert.equal((await request(`/gateway/sessions/${secondOverview.currentSessionId}/revoke`,admin,'POST',{})).status,404);
pass('CSRF-checked session revocation invalidates only the chosen session');
const marker='redaction-test-private-query-string';
await request(`/gateway/not-found?password=${marker}`,admin);
const snapshot=await json('/gateway/support-snapshot',admin), serialized=JSON.stringify(snapshot);
assert.equal(snapshot.format,'sparkstudio-support-snapshot');
for(const secret of [marker,admin.csrf,accounts.admin.password,accounts.admin.username])assert.ok(!serialized.includes(secret));
assert.ok(!Object.hasOwn(snapshot,'sessions')); assert.ok(snapshot.metrics.requestWindow.some(item=>item.status>=400));
assert.ok(snapshot.metrics.processWorkingSetBytes>0); assert.ok(snapshot.metrics.uptimeSeconds>=0);
pass('support snapshot includes measured metrics without identities, query strings, tokens or secrets');
for(let index=0;index<135;index++)await request('/gateway/diagnostics',admin);
const metrics=await json('/gateway/diagnostics',admin);
assert.equal(metrics.requestWindow.length,128); assert.ok(metrics.completedRequests>=135);
assert.ok(metrics.requestWindow.every(item=>!item.route.includes('?')&&item.durationMs>=0));
pass('API observation retention stays bounded while lifetime counters continue');
for(const session of [admin,operator,designer])await request('/auth/logout',session,'POST',{audience:session.audience});
console.log(`${checks} gateway console groups passed.`);
