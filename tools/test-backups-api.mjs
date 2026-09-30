// Authenticated checks only against a disposable locally started gateway.
import assert from 'node:assert/strict';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
const fixture = await realpath(process.argv[2] ?? '');
assert.ok(fixture.toLowerCase().startsWith((await realpath('.data')).toLowerCase() + path.sep));
assert.match(path.basename(fixture), /^scheduled-backup-integration-[a-f0-9]{32}$/);
const base = 'http://127.0.0.1:5091', credentialsPath = path.join(fixture, 'test-accounts.json');
const accounts = { admin:{username:'backup-admin',password:randomBytes(24).toString('base64url')},designer:{username:'backup-designer',password:randomBytes(24).toString('base64url')} };
let cookie = '', csrf = '', audience = 'engineering';
async function api(route, method='GET', body, expected=200) {
  const reply = await fetch(base+route,{method,redirect:'error',signal:AbortSignal.timeout(60000),headers:{'X-SPARK-AUDIENCE':audience,...(cookie?{Cookie:cookie}:{}),...(csrf?{'X-SPARK-CSRF':csrf}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
  const data = await reply.json(); assert.equal(reply.status,expected,`${method} ${route}: ${reply.status}: ${JSON.stringify(data)}`);
  if(reply.headers.getSetCookie().length)cookie=reply.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
  if(data.csrfToken)csrf=data.csrfToken;
  return data;
}
async function login(who,target='engineering'){cookie='';csrf='';audience=target;await api('/api/auth/login','POST',{...who,audience});}
assert.equal((await api('/api/auth/session?audience=engineering')).setupRequired,true,'Use a fresh disposable gateway.');
const setupCode=(await readFile(path.join(fixture,'data/security/setup-code.txt'),'utf8')).trim();
await api('/api/auth/setup','POST',{...accounts.admin,setupCode});
await writeFile(credentialsPath,JSON.stringify(accounts,null,2),{mode:0o600});
let initial=await api('/api/gateway/backups');
assert.equal(initial.saved.enabled,false);assert.equal(initial.saved.retentionDays,7);assert.equal(initial.saved.dailyTime,'02:00');
const phrase=randomBytes(24).toString('base64url');
const savedCsrf=csrf;csrf='';await api('/api/gateway/backups','PUT',{revision:initial.revision,settings:initial.saved},403);csrf=savedCsrf;
await api('/api/gateway/backups/run','POST',{deliver:false},400);
const saved=await api('/api/gateway/backups','PUT',{revision:initial.revision,settings:initial.saved,archivePassphrase:phrase});
assert.equal(saved.hasArchivePassphrase,true);assert.ok(!JSON.stringify(saved).includes(phrase));
await api('/api/gateway/backups','PUT',{revision:initial.revision,settings:initial.saved},409);
console.log('PASS administrator backup settings, secret redaction, CSRF and stale-save protection');
await api('/api/security/users','POST',{...accounts.designer,projectGrants:{default:{design:true,view:true}}},201);
await login(accounts.designer);await api('/api/gateway/backups','GET',undefined,403);await api('/api/gateway/backups/run','POST',{deliver:false},403);
await login(accounts.admin,'operator');await api('/api/gateway/backups','GET',undefined,401);
await login(accounts.admin);
console.log('PASS designer/operator sessions cannot administer or download gateway backups');
const begun=await api('/api/gateway/backups/run','POST',{deliver:false},202);
assert.equal(begun.running,true);
let complete;
for(let i=0;i<100;i++){complete=await api('/api/gateway/backups');if(!complete.running)break;await new Promise(resolve=>setTimeout(resolve,100));}
assert.equal(complete.lastRun.status,'succeeded',JSON.stringify(complete.lastRun));assert.ok(complete.downloadId);
const download=await fetch(base+'/api/gateway/backups/download/'+complete.downloadId,{headers:{Cookie:cookie,'X-SPARK-AUDIENCE':'engineering'},signal:AbortSignal.timeout(20000)});
assert.equal(download.status,200);assert.equal(download.headers.get('cache-control'),'no-store');
const bytes=Buffer.from(await download.arrayBuffer());assert.equal(bytes.subarray(0,8).toString(),'SPARKBAK');
assert.equal(bytes.length,complete.lastRun.bytes);assert.ok(download.headers.get('content-disposition').includes('.sparkbak'));
await writeFile(path.join(fixture,'download.sparkbak'),bytes);await writeFile(path.join(fixture,'backup-test-secret.json'),JSON.stringify({passphrase:phrase}),{mode:0o600});
await login(accounts.designer);await api('/api/gateway/backups/download/'+complete.downloadId,'GET',undefined,403);
await login(accounts.admin);await api('/api/gateway/backups/download/00000000000000000000000000000000','GET',undefined,404);
console.log('PASS asynchronous local archive creation and authenticated exact-byte download');
const restored=await api('/api/gateway/backups');
await api('/api/gateway/backups','PUT',{revision:restored.revision,settings:{...restored.saved,enabled:true}},400);
const catalog=await api('/api/projects');
assert.ok(catalog.projects.length>0);
console.log('PASS invalid schedules do not disturb gateway projects');
