#!/usr/bin/env node
// Creates only independently authored memory tags; never connects to equipment.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const args = process.argv.slice(2), publish = args.includes('--publish'), positional = args.filter(arg => !arg.startsWith('--'));
assert.ok(args.every(arg => !arg.startsWith('--') || arg === '--publish') && positional.length <= 1);
const base = new URL(positional[0] ?? 'http://127.0.0.1:5091');
assert.ok(base.protocol === 'http:' && ['localhost','127.0.0.1'].includes(base.hostname) && ['5090','5091','5093','6090'].includes(base.port) && base.pathname === '/' && !base.username && !base.password && !base.search && !base.hash);
assert.ok(process.env.SPARKSTUDIO_ADMIN_AUTH_FILE, 'Set SPARKSTUDIO_ADMIN_AUTH_FILE to a local administrator credential file.');
const stored = JSON.parse(await readFile(process.env.SPARKSTUDIO_ADMIN_AUTH_FILE,'utf8')), account = stored.admin ?? stored;
const example = JSON.parse(await readFile(new URL('../examples/equipment-commands.json',import.meta.url),'utf8'));
const loginResponse = await fetch(new URL('/api/auth/login',base), {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({audience:'engineering',username:account.username,password:account.password}),redirect:'error'});
assert.equal(loginResponse.status,200,'Administrator login failed.');
const login = await loginResponse.json(), cookie=loginResponse.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
async function api(path,method='GET',body) {
  const response=await fetch(new URL('/api'+path,base),{method,headers:{'Content-Type':'application/json','X-SPARK-AUDIENCE':'engineering','X-SPARK-CSRF':login.csrfToken,Cookie:cookie},body:body===undefined?undefined:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(20000)});
  const text=await response.text(); assert.ok(response.ok,`${method} ${path}: ${response.status} ${text.slice(0,300)}`);return text?JSON.parse(text):null;
}
try {
  const [catalog,tags] = await Promise.all([api('/projects'),api('/tag-definitions')]);
  assert.ok(!catalog.projects.some(project=>project.name===example.name),'Workshop project already exists; no changes made.');
  assert.ok(!tags.some(tag=>tag.path.startsWith('[default]CommandWorkshop/')),'Workshop tags already exist; no changes made.');
  const package_={format:'sparkstudio.tags',version:1,tags:example.tags};
  const review=await api('/tag-engineering/preview','POST',package_);
  assert.ok(review.canApply!==false && review.changes.every(change=>change.action==='add'),'Tag preview must add only workshop tags.');
  await api('/tag-engineering/apply','POST',{package:package_,revision:review.revision,previewToken:review.previewToken});
  const created=await api('/projects','POST',{name:example.name}), route=`/projects/${created.id}`;
  const draft=await api(route+'/project');
  const saved=await api(route+'/project','PUT',{...draft,screens:example.screens,templates:[],parameters:{},commands:example.commands});
  if(publish) {
    const publication=await api(route+'/project/publication-review');
    assert.equal(publication.revision,saved.revision,'Workshop changed before publication review.');
    await api(route+'/project/publish','POST',{revision:publication.revision,scriptsRevision:publication.scriptsRevision,reviewToken:publication.reviewToken});
  }
  console.log(`Created synthetic command workshop at ${new URL(`${publish?'/runtime/':'/designer/'}${created.id}`,base)}. No equipment connections or device writes.`);
} finally {await api('/auth/logout','POST',{audience:'engineering'});}
