import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import React from 'react';
import ts from 'typescript';

const require = createRequire(import.meta.url), asModule = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const hookUrl = asModule(`let values=[],index=0,effects=[],context;export const begin=()=>{index=0};export const clear=()=>{for(const v of values)v?.cleanup?.();values=[];effects=[];index=0};export const setContext=v=>{context=v};export const createContext=v=>({Provider:()=>null});export const useContext=()=>context;export const useState=initial=>{const at=index++;if(!(at in values))values[at]={value:typeof initial==='function'?initial():initial};return[values[at].value,next=>{values[at].value=typeof next==='function'?next(values[at].value):next}]};export const useRef=initial=>{const at=index++;return values[at]??={current:initial}};export const useMemo=(fn,deps)=>{const at=index++;if(!values[at]||deps.some((v,i)=>!Object.is(values[at].deps[i],v)))values[at]={deps,value:fn()};return values[at].value};export const useCallback=(fn,deps)=>useMemo(()=>fn,deps);export const useEffect=(fn,deps)=>{const at=index++;if(!values[at]||deps.some((v,i)=>!Object.is(values[at].deps[i],v))){values[at]?.cleanup?.();values[at]={deps};effects.push(()=>{values[at].cleanup=fn()})}};export const flush=()=>{const next=effects;effects=[];next.forEach(fn=>fn())};export const useLayoutEffect=useEffect;export const useId=()=>"auth-test";`);
const modules = new Map();
function moduleUrl(name) {
  if (name.endsWith('.json')) return 'data:text/javascript;base64,' + Buffer.from('export default ' + fs.readFileSync(new URL('src/' + name, import.meta.url), 'utf8')).toString('base64');
  if (modules.has(name)) return modules.get(name);
  const file = ['tsx','ts'].map(ext => new URL(`src/${name}.${ext}`, import.meta.url)).find(url => fs.existsSync(url));
  let source = fs.readFileSync(file, 'utf8');
  if (name === 'Security') source += '\nexport { UserEditor, GatewaySettingsEditor };';
  const output = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText
    .replace(/import "\.\/[^"\n]+\.css";\r?\n/g,'')
    .replace(/(from\s+|import\s+)(["'])([^"']+)\2/g,(_all,prefix,_q,dependency)=>`${prefix}${JSON.stringify(dependency==='react'?hookUrl:dependency.startsWith('./')?moduleUrl(dependency.slice(2)):pathToFileURL(require.resolve(dependency)).href)}`);
  const url=asModule(output); modules.set(name,url); return url;
}
const transport = await import(moduleUrl('authSession'));
const {api,ApiError} = await import(moduleUrl('api'));
const {exportProjectPackage,importProjectPackage} = await import(moduleUrl('projectManagement'));
const {AuthProvider,AuthGate} = await import(moduleUrl('Auth'));
const {UserEditor,GatewaySettingsEditor} = await import(moduleUrl('Security'));
const hooks = await import(hookUrl);
const nativeFetch=globalThis.fetch,nativeWindow=globalThis.window,nativeChannel=globalThis.BroadcastChannel;
const stored = new Map();
const windowMock = Object.assign(new EventTarget(),{location:{href:'http://gateway.local/designer/plant',origin:'http://gateway.local',pathname:'/designer/plant'},setInterval:()=>1,clearInterval:()=>{},localStorage:{getItem:key=>stored.get(key)??null,setItem:(key,value)=>stored.set(key,value),removeItem:key=>stored.delete(key)}});
globalThis.window=windowMock;globalThis.BroadcastChannel=undefined;
const noPermissions={view:false,operate:false,design:false,publish:false};
const session=(overrides={})=>({setupRequired:false,audience:'engineering',user:{id:'user-a',username:'admin',displayName:'Administrator',gatewayAdmin:true},csrfToken:'csrf-a',permissions:{view:true,operate:true,design:true,publish:true,gatewayAdmin:true},project:{id:'plant',name:'Plant'},operatorBaseUrl:null,...overrides});
const configure=(overrides={})=>transport.configureAuthSession({audience:'engineering',projectId:'plant',csrfToken:'csrf-a',key:'user-a',...overrides});
const response=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const defer=()=>{let resolve;const promise=new Promise(done=>{resolve=done});return{promise,resolve}};
const nodes=node=>!node||typeof node!=='object'?[]:[node,...React.Children.toArray(node.props?.children).flatMap(nodes)];
function drive(Component,props){hooks.clear();let tree;const render=()=>{hooks.begin();tree=Component(props);return tree};render();return{render,get tree(){return tree},find:predicate=>{const result=nodes(tree).find(predicate);assert.ok(result,'Expected rendered control');return result}}}
let passed=0;
async function check(name,run){stored.clear();await run();passed++;console.log(`PASS ${name}`)}
try {
  await check('authenticated reads and mutations carry audience/project and mutation-only CSRF without storage',async()=>{
    configure();const calls=[];globalThis.fetch=async(...args)=>{calls.push(args);return response(args[0].includes("/project") ? {id:"plant",name:"Plant",revision:1,parameters:{},screens:[]} : [])};
    await api('/tags');await api('/project','PUT',{name:'Plant'});
    assert.equal(calls[0][1].headers.get('X-SPARK-AUDIENCE'),'engineering');assert.equal(calls[0][1].headers.get('X-SPARK-PROJECT'),'plant');assert.equal(calls[0][1].headers.get('X-SPARK-CSRF'),null);
    assert.equal(calls[1][1].headers.get('X-SPARK-CSRF'),'csrf-a');assert.equal(calls[1][1].credentials,'same-origin');assert.equal(calls[1][1].redirect,'error');assert.equal(calls[1][1].headers.get('content-type'),'application/json');
    assert.deepEqual([...new URL(transport.eventStreamUrl(),'http://gateway.local').searchParams.keys()],['audience','projectId']);assert.doesNotMatch(transport.eventStreamUrl(),/csrf|user-a/);
  });
  await check('transport refuses cross-origin requests before sending session headers',async()=>{
    let calls=0;globalThis.fetch=async()=>{calls++;return response({})};await assert.rejects(transport.authenticatedFetch('https://other.example/api/users'),/origin/);assert.equal(calls,0);
  });
  await check('401 signals session expiry without navigation; 403 retains a permission error',async()=>{
    configure();let expired=0;const listener=()=>expired++;window.addEventListener(transport.authExpiredEvent,listener);
    globalThis.fetch=async()=>response({},401);await assert.rejects(api('/tags'),error=>error instanceof ApiError&&error.status===401&&/Sign in/.test(error.message));assert.equal(expired,1);
    globalThis.fetch=async()=>response({},403);await assert.rejects(api('/connections'),error=>error.status===403&&/permission/.test(error.message));assert.equal(expired,1);window.removeEventListener(transport.authExpiredEvent,listener);
  });
  await check('late success and late 401 from an old session cannot affect the replacement session',async()=>{
    for(const status of [200,401]){configure();const gate=defer();let expired=0;const listener=()=>expired++;window.addEventListener(transport.authExpiredEvent,listener);globalThis.fetch=()=>gate.promise;const request=transport.authenticatedFetch('/api/tags');configure({csrfToken:'csrf-b',key:'user-b'});gate.resolve(response({old:true},status));await assert.rejects(request,/session changed/);assert.equal(expired,0);window.removeEventListener(transport.authExpiredEvent,listener)}
  });
  await check('API and package bodies finishing after a session change cannot resolve or download',async()=>{
    for(const kind of ['api','import','export']){
      configure();const gate=defer(),reply=response({});reply[kind==='api'?'text':kind==='import'?'json':'blob']=()=>gate.promise;globalThis.fetch=async()=>reply;
      const pending=kind==='api'?api('/tags'):kind==='import'?importProjectPackage(new File(['package'],'app.sparkproj')):exportProjectPackage({id:'plant',name:'Plant'});await settle();configure({csrfToken:'new-token',key:'new-user'});gate.resolve(kind==='api'?'{}':kind==='import'?{id:'old'}:new Blob(['old']));await assert.rejects(pending,/session changed/);
    }
  });
  await check('initial session query contains the audience/project; unchanged polls preserve app identity',async()=>{
    const calls=[];globalThis.fetch=async(url,init)=>{calls.push([url,init]);return response(session())};
    const ui=drive(AuthProvider,{audience:'engineering',projectId:'plant',children:'app'});hooks.flush();await settle();ui.render();const first=ui.tree.props.value;
    assert.equal(calls[0][0],'/api/auth/session?audience=engineering&projectId=plant');assert.equal(first.phase,'ready');assert.equal(first.user.id,'user-a');await first.refresh();ui.render();assert.equal(ui.tree.props.value.epoch,first.epoch);
    hooks.setContext(ui.tree.props.value);const gate=AuthGate({children:'app'});assert.equal(gate.key,String(first.epoch));
  });
  await check('changed rights and revoked sessions discard the protected app identity',async()=>{
    let current=session();globalThis.fetch=async()=>response(current);const ui=drive(AuthProvider,{audience:'engineering',projectId:'plant',children:'app'});hooks.flush();await settle();ui.render();const original=ui.tree.props.value.epoch;
    current=session({permissions:{...noPermissions,view:true},user:{id:'user-a',username:'admin',displayName:'Administrator',gatewayAdmin:false}});await ui.tree.props.value.refresh();ui.render();assert.ok(ui.tree.props.value.epoch>original);hooks.setContext(ui.tree.props.value);assert.ok(nodes(AuthGate({children:'private'})).some(node=>node.props?.role==='alert'));
    current=session({user:null,csrfToken:null,permissions:noPermissions});await ui.tree.props.value.refresh();ui.render();assert.equal(ui.tree.props.value.user,null);hooks.setContext(ui.tree.props.value);assert.equal(AuthGate({children:'private'}).props.children.type.name,'SignInForm');
  });
  await check('signout clears app and token before response and stops polling from restoring the cookie',async()=>{
    let calls=0,logout;globalThis.fetch=async(url,init)=>{calls++;if(url.endsWith('/logout')){logout=init;return response({ok:true})}return response(session())};const ui=drive(AuthProvider,{audience:'engineering',projectId:'plant',children:'app'});hooks.flush();await settle();ui.render();const signingOut=ui.tree.props.value.signOut();ui.render();assert.equal(ui.tree.props.value.user,null);assert.equal(transport.authHeaders('POST').get('X-SPARK-CSRF'),null);await signingOut;assert.equal(logout.headers.get('X-SPARK-CSRF'),'csrf-a');assert.deepEqual(JSON.parse(logout.body),{audience:'engineering'});const before=calls;await ui.tree.props.value.refresh();assert.equal(calls,before);
  });
  await check('a delayed logout blocks replacement login until its cookie-clearing response settles',async()=>{
    const gate=defer();let logins=0;globalThis.fetch=async(url)=>{if(url.endsWith('/logout'))return gate.promise;if(url.endsWith('/login'))logins++;return response(session())};const ui=drive(AuthProvider,{audience:'engineering',projectId:'plant',children:'app'});hooks.flush();await settle();ui.render();const logout=ui.tree.props.value.signOut();ui.render();assert.equal(ui.tree.props.value.phase,'signingOut');hooks.setContext(ui.tree.props.value);assert.ok(nodes(AuthGate({children:'private'})).some(node=>node.type==='h1'&&node.props.children==='Signing out'));
    await assert.rejects(ui.tree.props.value.signIn('new-user','explicit-test-password'),/still finishing/);assert.equal(logins,0);gate.resolve(response({ok:true}));await logout;ui.render();await ui.tree.props.value.signIn('new-user','explicit-test-password');assert.equal(logins,1);
  });
  await check('failed logout remains locked after reload while only a non-secret intent is stored',async()=>{
    globalThis.fetch=async url=>{if(url.endsWith('/logout'))throw Error('Offline');return response(session())};let ui=drive(AuthProvider,{audience:'engineering',projectId:'plant',children:'app'});hooks.flush();await settle();ui.render();await ui.tree.props.value.signOut();ui.render();assert.match(ui.tree.props.value.notice,/could not confirm/);assert.deepEqual([...stored],[['sparkstudio.auth.signout.engineering','1']]);
    ui=drive(AuthProvider,{audience:'engineering',projectId:'plant',children:'app'});hooks.flush();await settle();ui.render();assert.equal(ui.tree.props.value.user,null);assert.equal(ui.tree.props.value.phase,'ready');await ui.tree.props.value.signIn('admin','explicit-test-password');ui.render();assert.equal(ui.tree.props.value.user.id,'user-a');assert.equal(stored.size,0);
  });
  await check('operator first-run gate never renders the administrator setup form',async()=>{
    hooks.setContext({phase:'ready',setupRequired:true,audience:'operator',user:null,refresh:async()=>{}});const gate=AuthGate({children:'private'});assert.ok(nodes(gate).some(node=>node.type==='h1'&&node.props.children==='Gateway setup pending'));assert.ok(!nodes(gate).some(node=>node.type?.name==='SignInForm'));
  });
  await check('password change carries the current audience, project and CSRF and returns to explicit sign-in',async()=>{
    for(const audience of ['engineering','operator']) {
      stored.clear();let changed;globalThis.fetch=async(url,init)=>{if(url.endsWith('/password')){changed=init;return response({changed:true})}return response(session({audience}))};
      const ui=drive(AuthProvider,{audience,projectId:'plant',children:'app'});hooks.flush();await settle();ui.render();const original=ui.tree.props.value.epoch;
      await ui.tree.props.value.changePassword('old-password-for-test','new-password-for-test');ui.render();
      assert.equal(changed.headers.get('X-SPARK-AUDIENCE'),audience);assert.equal(changed.headers.get('X-SPARK-PROJECT'),'plant');assert.equal(changed.headers.get('X-SPARK-CSRF'),'csrf-a');
      assert.equal(changed.credentials,'same-origin');assert.equal(changed.redirect,'error');assert.deepEqual(JSON.parse(changed.body),{currentPassword:'old-password-for-test',newPassword:'new-password-for-test'});
      assert.equal(ui.tree.props.value.user,null);assert.ok(ui.tree.props.value.epoch>original);assert.equal(transport.authHeaders('POST').get('X-SPARK-CSRF'),null);
      assert.equal(ui.tree.props.value.notice,'Password changed. Sign in with your new password.');assert.deepEqual([...stored],[[`sparkstudio.auth.signout.${audience}`,'1']]);
    }
  });
  await check('password mutation fences in-flight refresh and prevents polling, duplicate mutations and replacement login',async()=>{
    const poll=defer(),mutation=defer();let sessionCalls=0,passwordCalls=0;
    globalThis.fetch=async url=>{if(url.endsWith('/password')){passwordCalls++;return mutation.promise}sessionCalls++;return sessionCalls===1?response(session()):poll.promise};
    const ui=drive(AuthProvider,{audience:'engineering',projectId:'plant',children:'app'});hooks.flush();await settle();ui.render();const stalePoll=ui.tree.props.value.refresh();
    const changing=ui.tree.props.value.changePassword('old-password-for-test','new-password-for-test');await ui.tree.props.value.refresh();assert.equal(sessionCalls,2);
    await assert.rejects(ui.tree.props.value.changePassword('old','replacement'),/still finishing/);assert.equal(passwordCalls,1);
    await assert.rejects(ui.tree.props.value.signIn('admin','replacement-password'),/still finishing/);
    mutation.resolve(response({changed:true}));await changing;poll.resolve(response(session()));await stalePoll;ui.render();
    assert.equal(ui.tree.props.value.user,null);assert.equal(ui.tree.props.value.notice,'Password changed. Sign in with your new password.');
  });
  await check('wrong current password and rate limits retain the authenticated account without storing credentials',async()=>{
    for(const status of[400,429]) {
      stored.clear();globalThis.fetch=async url=>url.endsWith('/password')?response({error:status===400?'Current password is incorrect.':'Too many attempts.'},status):response(session());
      const ui=drive(AuthProvider,{audience:'engineering',projectId:'plant',children:'app'});hooks.flush();await settle();ui.render();const original=ui.tree.props.value.epoch;
      await assert.rejects(ui.tree.props.value.changePassword('wrong-current','new-password-for-test'),status===400?/incorrect/:/Too many/);ui.render();
      assert.equal(ui.tree.props.value.user.id,'user-a');assert.equal(ui.tree.props.value.epoch,original);assert.equal(stored.size,0);await ui.tree.props.value.refresh();
    }
  });
  await check('an unconfirmed password response does not claim success or sign out',async()=>{
    globalThis.fetch=async url=>response(url.endsWith('/password')?{changed:false}:session());const ui=drive(AuthProvider,{audience:'engineering',projectId:'plant',children:'app'});hooks.flush();await settle();ui.render();
    await assert.rejects(ui.tree.props.value.changePassword('old-password-for-test','new-password-for-test'),/did not confirm/);ui.render();assert.equal(ui.tree.props.value.user.id,'user-a');assert.equal(stored.size,0);
  });
  await check('password confirmation replaces an intervening expiry notice with the actionable new-password message',async()=>{
    const gate=defer();globalThis.fetch=async url=>url.endsWith('/password')?gate.promise:response(session());const ui=drive(AuthProvider,{audience:'engineering',projectId:'plant',children:'app'});hooks.flush();await settle();ui.render();
    const changing=ui.tree.props.value.changePassword('old-password-for-test','new-password-for-test');window.dispatchEvent(new Event(transport.authExpiredEvent));gate.resolve(response({changed:true}));await changing;ui.render();
    assert.equal(ui.tree.props.value.user,null);assert.equal(ui.tree.props.value.notice,'Password changed. Sign in with your new password.');
  });
  await check('password response after provider unmount cannot clear a replacement session',async()=>{
    const gate=defer();globalThis.fetch=async url=>url.endsWith('/password')?gate.promise:response(session());const ui=drive(AuthProvider,{audience:'engineering',projectId:'plant',children:'app'});hooks.flush();await settle();ui.render();
    const changing=ui.tree.props.value.changePassword('old-password-for-test','new-password-for-test');hooks.clear();configure({csrfToken:'replacement-token',key:'replacement-user'});gate.resolve(response({changed:true}));await changing;
    assert.equal(transport.authHeaders('POST').get('X-SPARK-CSRF'),'replacement-token');assert.equal(stored.size,0);
  });
  await check('login submits only explicit credentials and selected audience, without CSRF or browser storage',async()=>{
    let login;globalThis.fetch=async(url,init)=>{if(url.endsWith('/login')){login=init;return response(session({audience:'operator'}))}return response(session({audience:'operator',user:null,csrfToken:null,permissions:noPermissions}))};
    const ui=drive(AuthProvider,{audience:'operator',projectId:'plant',children:'app'});hooks.flush();await settle();ui.render();await ui.tree.props.value.signIn('operator-a','explicit-test-password');ui.render();assert.deepEqual(JSON.parse(login.body),{audience:'operator',username:'operator-a',password:'explicit-test-password',projectId:'plant'});assert.equal(login.headers.get('X-SPARK-CSRF'),null);assert.equal(ui.tree.props.value.user.id,'user-a');
  });
  await check('admin grant controls enforce operate/view and publish/design dependencies independently',()=>{
    const ui=drive(UserEditor,{user:null,projects:[{id:'plant',name:'Plant'}],onClose(){},onSaved:async()=>{}});
    const control=label=>ui.find(node=>node.props?.['aria-label']===label);control('Operate Plant').props.onChange({target:{checked:true}});ui.render();assert.equal(control('View Plant').props.checked,true);assert.equal(control('Design Plant').props.checked,false);
    control('Publish Plant').props.onChange({target:{checked:true}});ui.render();assert.equal(control('Design Plant').props.checked,true);control('View Plant').props.onChange({target:{checked:false}});ui.render();assert.equal(control('Operate Plant').props.checked,false);assert.equal(control('Publish Plant').props.checked,true);control('Design Plant').props.onChange({target:{checked:false}});ui.render();assert.equal(control('Publish Plant').props.checked,false);
  });
  await check('username browser validation accepts allowed ASCII names with the HTML Unicode-sets flag',()=>{
    const ui=drive(UserEditor,{user:null,projects:[],onClose(){},onSaved:async()=>{}});const field=ui.find(node=>node.type==='input'&&node.props.pattern);const pattern=new RegExp(`^(?:${field.props.pattern})$`,'v');assert.ok(pattern.test('ops-user_1.2'));assert.equal(pattern.test('two words'),false);
  });
  await check('settings updates retain undisplayed project scopes and revision and normalize blank base URL',async()=>{
    configure();let body;const calls=[];globalThis.fetch=async(url,init)=>{calls.push([url,init.method]);body=JSON.parse(init.body);return response({...body,revision:5})};const settings={revision:4,publicBaseUrl:'https://operators.example.com',projectTagPrefixes:{archived:['[default]Archived/'],plant:['[default]Plant/']}};
    const ui=drive(GatewaySettingsEditor,{settings,projects:[{id:'plant',name:'Plant'}],reloading:false,onReload:async()=>true,onStateChange(){},onSaved:async()=>{}});hooks.flush();ui.render();
    ui.find(node=>node.type==='input'&&node.props.type==='url').props.onChange({target:{value:'  '}});ui.render();
    assert.equal(ui.find(node=>node.type==='button'&&node.props.type==='submit').props.disabled,false);
    ui.find(node=>node.type==='form').props.onSubmit({preventDefault(){}});await settle();assert.deepEqual(calls,[['/api/security/settings','PUT']]);assert.equal(body.revision,4);assert.equal(body.publicBaseUrl,null);assert.deepEqual(body.projectTagPrefixes,settings.projectTagPrefixes);
  });
} finally {hooks.clear();globalThis.fetch=nativeFetch;if(nativeWindow===undefined)delete globalThis.window;else globalThis.window=nativeWindow;globalThis.BroadcastChannel=nativeChannel;}
console.log(`${passed} authentication/session/admin checks passed.`);
