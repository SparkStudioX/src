import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const compile = name => ts.transpileModule(fs.readFileSync(new URL(`./src/${name}.ts`, import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const asModule = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const authSessionModule = asModule(compile('authSession'));
const previewRequestModule = asModule(compile('previewRequest'));
const apiModule = asModule(compile('api').replaceAll('"./authSession"', JSON.stringify(authSessionModule)).replaceAll('"./previewRequest"', JSON.stringify(previewRequestModule)));
const { api, ApiError, parseProjectRoute, currentProjectId, projectPage, apiUrl, projectStorageKey } = await import(apiModule);
const { importProjectPackage, exportProjectPackage, packageSizeLimit } = await import(asModule(compile('projectManagement').replaceAll('"./api"', JSON.stringify(apiModule))));
let checks = 0;
const check = async (name, run) => { await run(); checks++; console.log(`PASS ${name}`); };

await check('home and default aliases have no implicit hard-coded project ID', () => {
  for (const path of ['/', '/projects', '/projects/']) assert.deepEqual(parseProjectRoute(path), { kind: 'home' });
  for (const kind of ['designer', 'runtime']) for (const suffix of ['', '/']) assert.deepEqual(parseProjectRoute(`/${kind}${suffix}`), { kind, projectId: null });
});
await check('canonical routes select the exact project, including trailing slash', () => {
  assert.deepEqual(parseProjectRoute('/designer/line-a'), { kind: 'designer', projectId: 'line-a' });
  assert.deepEqual(parseProjectRoute('/runtime/line-b/'), { kind: 'runtime', projectId: 'line-b' });
  assert.deepEqual(parseProjectRoute('/designer/%64efault'), { kind: 'designer', projectId: 'default' });
});
await check('security has a dedicated gateway route without a project ID', () => {
  for (const path of ['/security', '/security/']) assert.deepEqual(parseProjectRoute(path), { kind: 'security' });
  assert.deepEqual(parseProjectRoute('/security/line-a'), { kind: 'invalid' });
});
await check('shared data workspace is available without a selected project', () => {
  for (const path of ['/workspace', '/workspace/']) assert.deepEqual(parseProjectRoute(path), { kind: 'workspace' });
  assert.deepEqual(parseProjectRoute('/workspace/project'), { kind: 'invalid' });
});
await check('malformed or non-catalog path fragments cannot select projects', () => {
  for (const path of ['/designer/a/b', '/designer//', '/runtime/../default', '/designer/%2fdefault', '/designer/%252fdefault', '/designer/%', '/designer/Uppercase', '/designer/1-a', '/designer/a_b', '/runtime/' + 'a'.repeat(65), '/random']) assert.deepEqual(parseProjectRoute(path), { kind: 'invalid' }, path);
});
await check('page helpers keep canonical project identity and reject unsafe IDs', () => {
  assert.equal(projectPage('designer', 'line-a'), '/designer/line-a');
  assert.equal(projectPage('runtime', 'line-b'), '/runtime/line-b');
  assert.equal(projectPage('runtime', null), '/runtime');
  assert.throws(() => projectPage('designer', '../other'));
});
await check('authoring, scripting, query and asset requests are scoped', () => {
  for (const path of ['/project', '/project/publication', '/queries', '/queries/production/execute', '/scripts/resources', '/scripts/run', '/assets', '/assets/image-id']) assert.equal(apiUrl(path, 'line-a'), `/api/projects/line-a${path}`);
});
await check('operator publications, browser scripts and actions are scoped', () => {
  for (const path of ['/runtime/project', '/runtime/scripts', '/runtime/queries', '/runtime/screens/home/components/button/action']) assert.equal(apiUrl(path, 'line-b'), `/api/projects/line-b${path}`);
});
await check('gateway resources and project catalog management stay global', () => {
  for (const path of ['/tags', '/tag-definitions', '/connections', '/opcua/browse', '/events', '/health', '/projects', '/projects/import?name=Copy', '/projects/line-a/export']) assert.equal(apiUrl(path, 'line-b'), `/api${path}`);
});
await check('query strings are retained and partial root names are not scoped', () => {
  assert.equal(apiUrl('/assets?filter=a%20b', 'line-a'), '/api/projects/line-a/assets?filter=a%20b');
  assert.equal(apiUrl('/project-other', 'line-a'), '/api/project-other');
  assert.equal(apiUrl('/scripts-other', 'line-a'), '/api/scripts-other');
});
await check('aliases and server-side model imports retain legacy API paths', () => {
  assert.equal(currentProjectId(), null);
  assert.equal(apiUrl('/project'), '/api/project');
  assert.equal(apiUrl('/runtime/project', null), '/api/runtime/project');
});
await check('API URL helper rejects external paths and invalid scoped IDs', () => {
  for (const path of ['https://example.com', '//example.com/path', '/assets\\other']) assert.throws(() => apiUrl(path, 'line-a'));
  assert.throws(() => apiUrl('/project', 'A'));
});
await check('project scratchpads do not share one browser storage key', () => {
  assert.equal(projectStorageKey('sparkstudio.script', 'line-a'), 'sparkstudio.script.project.line-a');
  assert.notEqual(projectStorageKey('sparkstudio.script', 'line-a'), projectStorageKey('sparkstudio.script', 'line-b'));
  assert.equal(projectStorageKey('sparkstudio.script', null), 'sparkstudio.script');
});

const nativeFetch = globalThis.fetch;
try {
  await check('requests derive context from the current canonical document', async () => {
    globalThis.window = { location: { pathname: '/designer/line-a', href: 'http://gateway.local/designer/line-a', origin: 'http://gateway.local' } };
    const calls = [];
    globalThis.fetch = async (...args) => { calls.push(args); return new Response(JSON.stringify(String(args[0]).includes('/project') ? {id:'plant',name:'Plant',revision:1,parameters:{},screens:[]} : []), { status: 200 }); };
    await api('/project', 'PUT', { name: 'Line A' });
    assert.equal(calls[0][0], '/api/projects/line-a/project');
    assert.equal(calls[0][1].body, '{"name":"Line A"}');
    window.location.pathname = '/runtime/line-b';
    await api('/runtime/project');
    await api('/tags');
    assert.equal(calls[1][0], '/api/projects/line-b/runtime/project');
    assert.equal(calls[2][0], '/api/tags');
  });
  await check('package import rejects empty, oversized and wrong extension files before network', async () => {
    globalThis.fetch = async () => { throw new Error('Unexpected network request'); };
    for (const file of [{ name: 'a.sparkproj', size: 0 }, { name: 'a.sparkproj', size: packageSizeLimit + 1 }, { name: 'a.json', size: 1 }]) await assert.rejects(importProjectPackage(file), /Choose/);
  });
  await check('package import posts raw binary to global management and preserves requested name', async () => {
    const file = new File(['zip'], 'factory.sparkproj');
    let call;
    globalThis.fetch = async (...args) => { call = args; return new Response('{"id":"imported","name":"New plant"}', { status: 200 }); };
    const result = await importProjectPackage(file, ' New plant ');
    assert.equal(call[0], '/api/projects/import?name=New%20plant');
    assert.equal(call[1].body, file);
    assert.equal(call[1].headers.get('Content-Type'), 'application/zip');
    assert.equal(result.id, 'imported');
  });
  await check('package failures retain gateway error details', async () => {
    globalThis.fetch = async () => new Response('{"error":"Package entry is invalid."}', { status: 400 });
    await assert.rejects(importProjectPackage(new File(['zip'], 'factory.sparkproj')), error => error instanceof ApiError && error.status === 400 && error.message === 'Package entry is invalid.');
  });
  await check('package export failures do not create a browser download', async () => {
    let endpoint;
    globalThis.fetch = async url => { endpoint = url; return new Response('{"message":"Project unavailable."}', { status: 404 }); };
    await assert.rejects(exportProjectPackage({ id: 'line-a', name: 'Plant A' }), /Project unavailable/);
    assert.equal(endpoint, '/api/projects/line-a/export');
  });
} finally {
  globalThis.fetch = nativeFetch;
  delete globalThis.window;
}

// Exercise the actual redirect effect and rendered fallback with a catalog
// response, without mounting the gateway application or starting a browser.
const require = createRequire(import.meta.url);
const redirectHooks = asModule(`
export const useState=initial=>[globalThis.__redirect.error ?? initial,value=>{globalThis.__redirect.error=value;}];
export const useEffect=run=>{globalThis.__redirect.effects.push(run);};
export const useCallback=value=>value; export const useRef=value=>({current:value});
`);
const redirectApi = asModule(`export const api=path=>globalThis.__redirect.request(path); export { projectPage } from ${JSON.stringify(apiModule)};`);
const emptyDefault = asModule('export default ()=>null;');
const redirectDeps = {
  react:redirectHooks, './api':redirectApi, './Icon':emptyDefault,
  './WorkspaceHeader':emptyDefault,
  './Theme':asModule('export const ThemePicker=()=>null;'),
  './Auth':asModule('export const useAuth=()=>({});'),
  './OperatorAccess':asModule('export const SessionIdentity=()=>null;'),
  './projectManagement':asModule('export const exportProjectPackage=()=>{};export const importProjectPackage=()=>{};'),
};
const redirectSource = ts.transpileModule(fs.readFileSync(new URL('./src/Projects.tsx',import.meta.url),'utf8'), {compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText
  .replace(/import "\.\/[^"\n]+\.css";\r?\n/g,'')
  .replace(/(from\s+|import\s+)(["'])([^"']+)\2/g,(_full,prefix,_quote,dependency)=>`${prefix}${JSON.stringify(redirectDeps[dependency] || pathToFileURL(require.resolve(dependency)).href)}`);
const { DefaultProjectRedirect } = await import(asModule(redirectSource));
const nodes = node => !node || typeof node !== 'object' ? [] : [node,...[node.props?.children].flat().flatMap(nodes)];
const settleRedirect = () => new Promise(resolve=>setImmediate(resolve));
try {
  await check('empty permitted catalogs show access guidance without redirecting either audience',async()=>{
    for(const kind of ['runtime','designer']) {
      const redirects=[];
      globalThis.window={location:{search:'',hash:'',replace:url=>redirects.push(url)}};
      globalThis.__redirect={effects:[],error:'',request:async path=>{assert.equal(path,'/projects');return {defaultProjectId:null,projects:[]};}};
      DefaultProjectRedirect({kind}); globalThis.__redirect.effects.shift()();
      await settleRedirect();
      const rendered=nodes(DefaultProjectRedirect({kind}));
      assert.deepEqual(redirects,[]);
      assert.match(rendered.find(node=>node.props?.role==='alert').props.children,/No projects are available.*grant project access/);
      assert.equal(rendered.find(node=>node.type==='a').props.href,kind==='runtime'?'/?audience=operator':'/');
    }
  });
  await check('permitted default redirects preserve exact identity and ignore responses after unmount',async()=>{
    const redirects=[];
    globalThis.window={location:{search:'?line=A',hash:'#details',replace:url=>redirects.push(url)}};
    globalThis.__redirect={effects:[],error:'',request:async()=>({defaultProjectId:'line-a',projects:[{id:'line-a'}]})};
    DefaultProjectRedirect({kind:'runtime'}); globalThis.__redirect.effects.shift()(); await settleRedirect();
    assert.deepEqual(redirects,['/runtime/line-a?line=A#details']);
    redirects.length=0;
    let finish;
    globalThis.__redirect={effects:[],error:'',request:()=>new Promise(resolve=>{finish=resolve;})};
    DefaultProjectRedirect({kind:'runtime'}); const cleanup=globalThis.__redirect.effects.shift()(); cleanup();
    finish({defaultProjectId:'line-b',projects:[{id:'line-b'}]}); await settleRedirect();
    assert.deepEqual(redirects,[]);
  });
} finally { delete globalThis.window; delete globalThis.__redirect; }
await check('Designer bookmarks select supported workspaces and a removed Connections pane cannot open', async () => {
  const source=fs.readFileSync(new URL('src/App.tsx',import.meta.url),'utf8'),ast=ts.createSourceFile('App.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  const initializer=ast.statements.find(node=>ts.isVariableStatement(node)&&node.declarationList.declarations.some(item=>item.name.getText(ast)==='initialWorkspace'));
  assert.ok(initializer);
  const code=ts.transpileModule(initializer.getText(ast)+'\nexport { initialWorkspace };',{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
  const {initialWorkspace}=await import(asModule(code));
  try {
    globalThis.window={location:{search:''}};
    for(const workspace of ['designer','tags','models','queries','scripts']){window.location.search='?workspace='+workspace;assert.equal(initialWorkspace(),workspace);}
    for(const search of ['?workspace=connections','?workspace=invalid','']){window.location.search=search;assert.equal(initialWorkspace(),'designer');}
  } finally {delete globalThis.window;}
});
console.log(`${checks} project routing/package checks passed.`);
