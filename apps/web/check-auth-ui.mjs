import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const require = createRequire(import.meta.url), modules = new Map();
const asModule = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const realReact = pathToFileURL(require.resolve('react')).href;
const hooks = asModule(`export * from ${JSON.stringify(realReact)};
export const useState = initial => [typeof initial === 'function' ? initial() : initial, value => globalThis.__authWrites.push(value)];
export const useEffect = () => {}; export const useCallback = value => value; export const useMemo = value => value();
export const useRef = value => ({current:value});`);
modules.set('Auth', asModule('export const useAuth=()=>globalThis.__authUiIdentity;'));
modules.set('Theme', asModule('export const ThemePicker=()=>null;'));
modules.set('ScriptEditor', asModule('export default function ScriptEditor(){return null;}'));
modules.set('browserScripts', asModule('export const useBrowserScripts=()=>{};'));
modules.set('GatewayConfiguration', asModule('export default function GatewayConfiguration(){return null;}'));

// Seed named application state without running requests or effects. Real child
// renderers and callback bodies are used, including the runtime read-only seam.
const seeded = new Set(['Projects', 'OperatorRuntime', 'Scripts', 'OperatorAccess', 'GatewayConsole', 'Security']);
function seedState(context) {
  const visit = node => {
    if (ts.isVariableDeclaration(node) && ts.isArrayBindingPattern(node.name) && node.initializer && ts.isCallExpression(node.initializer)
      && node.initializer.expression.getText() === 'useState') {
      const name = node.name.elements[0].name.getText();
      const original = node.initializer.arguments[0] || ts.factory.createIdentifier('undefined');
      const access = ts.factory.createElementAccessExpression(ts.factory.createIdentifier('globalThis.__authUiState'), ts.factory.createStringLiteral(name));
      const arg = ts.factory.createConditionalExpression(
        ts.factory.createCallExpression(ts.factory.createIdentifier('Object.hasOwn'), undefined, [ts.factory.createIdentifier('globalThis.__authUiState'), ts.factory.createStringLiteral(name)]), undefined,
        access, undefined, original);
      return ts.factory.updateVariableDeclaration(node, node.name, node.exclamationToken, node.type,
        ts.factory.updateCallExpression(node.initializer, node.initializer.expression, node.initializer.typeArguments, [arg]));
    }
    return ts.visitEachChild(node, visit, context);
  };
  return source => ts.visitNode(source, visit);
}
function moduleUrl(name) {
  if (modules.has(name)) return modules.get(name);
  const file = ['tsx', 'ts'].map(ext => new URL(`src/${name}.${ext}`, import.meta.url)).find(url => fs.existsSync(url));
  assert.ok(file, name);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    transformers: seeded.has(name) ? { before: [seedState] } : undefined }).outputText
    .replace(/import "\.\/[^"\n]+\.css";\r?\n/g, '')
    .replace(/(from\s+|import\s+)(["'])([^"']+)\2/g, (_full, prefix, _quote, dependency) => `${prefix}${JSON.stringify(dependency === 'react' && (seeded.has(name) || ['applicationState', 'inputStateBindings', 'LocalizationContext', 'useRuntimeSessionMessaging', 'useQueryPropertyBindings'].includes(name)) ? hooks : dependency.startsWith('./') ? moduleUrl(dependency.slice(2)) : pathToFileURL(require.resolve(dependency)).href)}`);
  const url = asModule(code); modules.set(name, url); return url;
}
const { operatorProjectLink, runtimePresentation } = await import(moduleUrl('operatorAccessModel'));
const { default: Projects, DefaultProjectRedirect } = await import(moduleUrl('Projects'));
const { default: OperatorRuntime } = await import(moduleUrl('OperatorRuntime'));
const { default: Scripts } = await import(moduleUrl('Scripts'));
const { ProjectProperties } = await import(moduleUrl('DocumentProperties'));
const { OperatorAccessDialog } = await import(moduleUrl('OperatorAccess'));
const { default: GatewayConsole } = await import(moduleUrl('GatewayConsole'));
const { default: Security } = await import(moduleUrl('Security'));
const noRights = { view:false,operate:false,commands:false,design:false,publish:false };
const noCapabilities = { diagnostics:false,configuration:false,backups:false,audit:false,sessions:false };
const identity = (audience, grants = {}, gatewayAdmin = false, capabilities = {}) => ({ audience, gatewayAdmin, gatewayCapabilities:gatewayAdmin ? Object.fromEntries(Object.keys(noCapabilities).map(key=>[key,true])) : {...noCapabilities,...capabilities}, gatewayAccess:gatewayAdmin || Object.values(capabilities).some(Boolean), permissions:{...noRights,...grants}, user:{id:'person',username:'alex',displayName:'Alex'}, publicOperatorBaseUrl:'', signOut:async()=>{}, refresh:async()=>{} });
const state = (auth, values = {}) => { globalThis.__authUiIdentity=auth; globalThis.__authUiState=values; globalThis.__authWrites=[]; };
const render = (Component, props = {}) => renderToStaticMarkup(React.createElement(Component, props));
const descendants = (node, test) => !node || typeof node !== 'object' ? [] : [...(test(node) ? [node] : []), ...React.Children.toArray(node.props?.children).flatMap(child=>descendants(child,test))];
const summary = (id, rights, published = true) => ({id,name:id,revision:7,archived:false,published,publishedRevision:5,permissions:{...noRights,...rights}});
const catalog = {defaultProjectId:'plant',projects:[summary('plant',{view:true,design:true}),summary('other',{view:true}),summary('draft',{design:true},false)]};
const component = (id,type,props) => ({id,type,x:0,y:0,width:200,height:80,props});
const project = {id:'plant',name:'Plant',revision:5,publishedAt:'2026-09-28T12:00:00Z',parameters:{},screens:[{id:'main',name:'Overview',width:1000,height:600,components:[
  component('entry','textInput',{text:'Enter work order',fieldKey:'order',defaultValue:''}),
  component('apply','button',{text:'Apply work order',action:'script'}),
  component('navigate','button',{text:'Go to report',action:'navigate',targetScreenId:'report'}),
  component('details','button',{text:'Open details',action:'openPopup',targetScreenId:'detail'}),
]},{id:'report',name:'Report',width:1000,height:600,components:[]},{id:'detail',name:'Detail',kind:'popup',width:400,height:200,components:[]}]};
let checks=0;
async function check(name, run) { await run(); checks++; console.log(`PASS ${name}`); }

await check('operator links remain stable project URLs with no session or publication data', () => {
  assert.equal(operatorProjectLink('line-a','','http://localhost:5090'),'http://localhost:5090/runtime/line-a');
  assert.equal(operatorProjectLink('line-a','https://hmi.factory.test/','http://localhost:5090'),'https://hmi.factory.test/runtime/line-a');
  assert.equal(operatorProjectLink('line-a','https://plant.example/spark/','http://localhost:5090'),'https://plant.example/spark/runtime/line-a');
  assert.equal(operatorProjectLink('line-a','https://plant.example/spark/','http://localhost:5090','controls'),'https://plant.example/spark/runtime/line-a?view=controls');
  assert.equal(operatorProjectLink('line-a','','http://localhost:5090','application'),'http://localhost:5090/runtime/line-a');
  for(const base of ['javascript:alert(1)','https://user:password@example.test','https://example.test?token=secret','https://example.test/#session']) assert.throws(()=>operatorProjectLink('line-a',base,'http://localhost'));
  for(const id of ['../x','A','x/y','a?token=x']) assert.throws(()=>operatorProjectLink(id,'','http://localhost'));
});
await check('runtime presentation defaults to application screens and controls require one explicit query value', () => {
  for(const search of ['', '?view=application', '?view=unknown', '?view=Controls', '?view=', '?view=controls&view=application', '?view=controls&view=controls']) assert.equal(runtimePresentation(search),'application',search);
  assert.equal(runtimePresentation('?view=controls'),'controls');
  assert.equal(runtimePresentation('?screen=report&view=controls'),'controls');
});
await check('operator catalog exposes applications without draft or management controls even with design grants', () => {
  state(identity('operator',{view:true,design:true},true),{catalog,loading:false});
  const html=render(Projects);
  assert.match(html,/Open application/); assert.match(html,/Switch user/);
  assert.match(html,/class="workspace-brand" href="\/\?audience=operator"/);
  assert.doesNotMatch(html,/Open designer|Saved draft|Rename|Duplicate|Archive|New project|Import \.sparkproj|Export \.sparkproj|Show archived|href="\/(?:security|gateway)"/);
  assert.doesNotMatch(html,/>draft</);
});
await check('default-project fallback links preserve the selected sign-in audience', () => {
  state(identity('operator',{view:true}),{error:'Project unavailable'});
  assert.match(render(DefaultProjectRedirect,{kind:'runtime'}),/href="\/\?audience=operator"/);
  state(identity('engineering',{design:true}),{error:'Project unavailable'});
  assert.match(render(DefaultProjectRedirect,{kind:'designer'}),/href="\/"/);
});
await check('engineering project cards require each project design permission and hide administrator management', () => {
  state(identity('engineering',{design:true}),{catalog,loading:false});
  const html=render(Projects);
  assert.match(html,/href="\/designer\/plant"/); assert.match(html,/Export \.sparkproj/);
  assert.doesNotMatch(html,/href="\/designer\/other"|Rename|Duplicate|New project|Import \.sparkproj|Show archived|href="\/(?:security|gateway)"/);
});
await check('gateway administrators retain catalog and security management', () => {
  state(identity('engineering',{design:true,publish:true},true),{catalog,loading:false});
  const html=render(Projects);
  for(const text of ['New project','Import .sparkproj','Rename','Duplicate','Archive','Show archived']) assert.ok(html.includes(text),text);
  assert.match(html,/class="workspace-header-link" href="\/gateway">Settings<\/a>/);
  assert.doesNotMatch(html,/href="\/security"/);
});
await check('runtime viewers see disabled forms and Python actions while navigation and popups stay available', () => {
  globalThis.window={location:{search:'?view=controls'}};
  state(identity('operator',{view:true}),{project,screenId:'main',parameters:{},tags:[],connected:true,loading:false});
  const html=render(OperatorRuntime);
  assert.match(html,/Read-only access/); assert.match(html.match(/<input[^>]*aria-label="Enter work order"[^>]*>/)?.[0] || '', /disabled=""/);
  assert.match(html,/<button[^>]*disabled=""[^>]*>[^]*?Apply work order/);
  assert.match(html,/<button[^>]*class="render-button"(?:(?!disabled)[^>])*>Go to report/);
  assert.match(html,/<button[^>]*class="render-button"(?:(?!disabled)[^>])*>Open details/);
  assert.doesNotMatch(html,/Engineering sign-in|>Projects</);
  const tree=OperatorRuntime();
  const views=descendants(tree,node=>node.props?.component?.id && Object.hasOwn(node.props,'readOnly'));
  assert.equal(views.length,4); assert.ok(views.every(node=>node.props.readOnly));
  views[0].props.onInputChange('order','new'); views[0].props.onScopedInputChange('scope','order','new');
  assert.equal(globalThis.__authWrites.length,0);
  delete globalThis.window;
});
await check('runtime operators can edit and design-capable identities receive an explicit engineering sign-in link', () => {
  globalThis.window={location:{search:'?view=controls'}};
  state(identity('operator',{view:true,operate:true,design:true}),{project,screenId:'main',parameters:{},tags:[],connected:true,loading:false});
  const html=render(OperatorRuntime);
  assert.doesNotMatch(html,/Read-only access/);
  assert.match(html,/Engineering sign-in/);
  assert.doesNotMatch(html.match(/<input[^>]*aria-label="Enter work order"[^>]*>/)?.[0] || '', /disabled=""/);
  delete globalThis.window;
});
await check('default runtime shows application screens without surrounding controls while preserving viewer permissions', () => {
  state(identity('operator',{view:true,design:true}),{project,screenId:'main',parameters:{},tags:[],connected:true,loading:false});
  const html=render(OperatorRuntime);
  assert.doesNotMatch(html, /class="operator-header"|class="operator-context"|class="operator-footer"|Read-only access|Engineering sign-in|Go to screen|Switch user|Sign out|Fullscreen/);
  assert.match(html.match(/<input[^>]*aria-label="Enter work order"[^>]*>/)?.[0] || '', /disabled=""/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>[^]*?Apply work order/);
  assert.match(html, /<button[^>]*class="render-button"(?:(?!disabled)[^>])*>Go to report/);
  assert.match(html, /<button[^>]*class="render-button"(?:(?!disabled)[^>])*>Open details/);
  const tree=OperatorRuntime();
  const views=descendants(tree,node=>node.props?.component?.id && Object.hasOwn(node.props,'readOnly'));
  assert.equal(views.length,4); assert.ok(views.every(node=>node.props.readOnly));
  views[0].props.onInputChange('order','new');
  assert.equal(globalThis.__authWrites.length,0);
});
await check('application-only runtime retains connection failures and application notifications', () => {
  state(identity('operator',{view:true,operate:true}),{project,screenId:'main',parameters:{},tags:[],connected:false,loading:false,notice:'Screen navigation unavailable',actionStatus:{success:true,message:'Saved operator request'}});
  const html=render(OperatorRuntime);
  assert.match(html, /Screen navigation unavailable/);
  assert.match(html, /Saved operator request/);
  assert.match(html, /offline|reconnect|disconnected|connection lost/i);
  assert.doesNotMatch(html, /class="operator-header"|class="operator-context"|class="operator-footer"/);
});
await check('script authors can edit resources but cannot publish or access manual Python tools without grants', () => {
  const draft={revision:2,resources:[{id:'helper',name:'helpers',type:'library',code:'result = 1',enabled:true,parameters:{}}]};
  state(identity('engineering',{design:true}),{draft,saved:JSON.stringify(draft),selectedId:'helper',openIds:['helper'],loading:false});
  const html=render(Scripts,{parameters:{},pythonAvailable:true,notify(){}});
  assert.match(html,/helpers\.py/); assert.match(html,/Administrator required to run/);
  assert.match(html,/<button[^>]*title="Your account needs publish permission[^>]*disabled=""[^>]*>[^]*?Publish application/);
  assert.doesNotMatch(html,/>Console<|>Save console<|>Run<|Script run source|Run parameters/);
});
await check('publishing scripts does not grant raw Python execution', () => {
  const draft={revision:2,resources:[{id:'helper',name:'helpers',type:'library',code:'result = 1',enabled:true,parameters:{}}]};
  state(identity('engineering',{design:true,publish:true}),{draft,saved:JSON.stringify(draft),selectedId:'helper',loading:false});
  const html=render(Scripts,{parameters:{},pythonAvailable:true,notify(){}});
  assert.match(html,/<button class="button primary"><[^]*?Publish application/);
  assert.doesNotMatch(html,/>Run<|>Console<|Script run source/);
});
await check('project name fields are read-only for nonadministrators and callback invocations cannot rename', () => {
  const changes=[];
  const props={project,onChange:value=>changes.push(value),notify(){},canRename:false};
  const html=render(ProjectProperties,props);
  assert.match(html,/aria-label="Project name"[^>]*readOnly=""/);
  const tree=ProjectProperties(props);
  const row=descendants(tree,node=>node.props?.label==='Name')[0];
  row.props.children('name').props.onChange({target:{value:'Forbidden rename'}});
  assert.deepEqual(changes,[]);
  assert.doesNotMatch(render(ProjectProperties,{...props,canRename:true}),/aria-label="Project name"[^>]*readOnly=""/);
});
await check('operator access panel shows configured address and publication metadata without auth tokens', () => {
  globalThis.window={location:{origin:'http://localhost:5090'}};
  state({...identity('engineering',{design:true}),publicOperatorBaseUrl:'https://operators.factory.test'});
  const html=render(OperatorAccessDialog,{projectId:'plant',projectName:'Plant',publication:{published:true,revision:5,publishedAt:project.publishedAt},onClose(){}});
  assert.match(html,/https:\/\/operators.factory.test\/runtime\/plant/); assert.match(html,/Revision 5/);
  assert.match(html,/Each person signs in/); assert.doesNotMatch(html,/csrf|token=|localhost/);
  assert.match(html, /Application only \(default\)/);
  assert.match(html, /<option value="application" selected="">/);
  delete globalThis.window;
});
await check('operator presentation selection regenerates the share URL and clears previous copy status', () => {
  globalThis.window={location:{origin:'http://localhost:5090'}};
  const auth={...identity('engineering',{design:true}),publicOperatorBaseUrl:'https://operators.factory.test'};
  const props={projectId:'plant',projectName:'Plant',publication:{published:true,revision:5},onClose(){}};
  state(auth,{presentation:'application',status:'Operator link copied.'});
  const tree=OperatorAccessDialog(props);
  const selector=descendants(tree,node=>node.type==='select')[0];
  assert.equal(selector.props.value,'application');
  selector.props.onChange({target:{value:'controls'}});
  assert.deepEqual(globalThis.__authWrites,['controls','']);
  state(auth,{presentation:'controls'});
  const html=render(OperatorAccessDialog,props);
  assert.match(html, /https:\/\/operators.factory.test\/runtime\/plant\?view=controls/);
  assert.match(html, /<option value="controls" selected="">/);
  assert.doesNotMatch(html, /Operator link copied\.|csrf|token=/);
  const controls=descendants(OperatorAccessDialog(props),node=>node.type==='select')[0];
  controls.props.onChange({target:{value:'application'}});
  assert.deepEqual(globalThis.__authWrites,['application','']);
  state(auth,{presentation:'application'});
  assert.doesNotMatch(render(OperatorAccessDialog,props), /\?view=/);
  delete globalThis.window;
});
await check('capability-only accounts receive gateway navigation without administrator project controls', () => {
  state(identity('engineering',{},false,{audit:true}),{catalog:{defaultProjectId:null,projects:[]},loading:false});
  const html=render(Projects);
  assert.match(html,/href="\/gateway">Settings/);
  assert.doesNotMatch(html,/New project|Import \.sparkproj|Show archived/);
});
await check('gateway sections reflect independent capabilities and forbidden hashes fall back to an allowed section', () => {
  globalThis.window={location:{hash:'#security'}};
  for(const capability of Object.keys(noCapabilities)) {
    state(identity('engineering',{},false,{[capability]:true}),{requestedSection:'security',data:null,busy:false});
    const html=render(GatewayConsole);
    const nav=html.match(/<nav aria-label="Gateway sections">([^]*?)<\/nav>/)?.[1] ?? '';
    assert.ok(nav.includes(`href="#${capability}"`),capability);
    for(const other of Object.keys(noCapabilities).filter(key=>key!==capability)) assert.ok(!nav.includes(`href="#${other}"`),`${capability} leaked ${other}`);
    assert.doesNotMatch(nav,/href="#security"|href="#recovery"/);
    assert.doesNotMatch(html,/Gateway accounts|New user/);
  }
  delete globalThis.window;
});
await check('account editor presents separate equipment command and gateway capability grants', () => {
  state(identity('engineering',{},true),{editing:'new',projects:[summary('plant',{})],loading:false});
  const html=render(Security,{section:'security'});
  assert.match(html,/aria-label="Equipment commands plant"/);
  for(const text of ['Gateway capabilities','Diagnostics and support snapshots','Tags, connections and deployment configuration','Backup configuration, creation and download','Audit history','Session inventory and revocation']) assert.ok(html.includes(text),text);
});
console.log(`${checks} authentication UI checks passed.`);
