import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import React from 'react';
import ts from 'typescript';

process.on('uncaughtException', error => { console.error(error.stack?.split('\n').filter(line => !line.includes('data:')).join('\n') ?? error.message); process.exit(1); });
process.on('unhandledRejection', error => { console.error(error?.message ?? error); process.exit(1); });
const require = createRequire(import.meta.url), url = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
const reactUrl = pathToFileURL(require.resolve('react')).href;
const hookUrl = url(`export * from ${JSON.stringify(reactUrl)}; export const memo=component=>component; export const useMemo=fn=>fn();
export const useContext=()=>globalThis.__parameterStateContext;
export const useState=value=>globalThis.__parameterStateHooks.useState(value);
export const useRef=value=>globalThis.__parameterStateHooks.useRef(value);
export const useEffect=(run,deps)=>globalThis.__parameterStateHooks.useEffect(run,deps);`);
const leafUrl = url(`import React from ${JSON.stringify(reactUrl)};export default function BoundComponent(props){return React.createElement('bound-leaf',{...props,state:globalThis.__parameterStateContext});}`);
const queryUrl = url('export const useQueryRepeater=source=>source?globalThis.__parameterQuery:{rows:[],key:"none",loading:false,error:""};');
function loader(harness = false) { const cache = new Map(); return function load(name) {
  if (name.endsWith('.json')) return 'data:text/javascript;base64,' + Buffer.from('export default ' + fs.readFileSync(new URL('src/' + name, import.meta.url), 'utf8')).toString('base64');
  if (cache.has(name)) return cache.get(name);
  const file = ['tsx', 'ts'].map(ext => new URL(`src/${name}.${ext}`, import.meta.url)).find(file => fs.existsSync(file)); assert.ok(file, name);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText
    .replace(/import "\.\/[^"\n]+\.css";\r?\n/g, '')
    .replace(/(from\s+|import\s+)(["'])([^"']+)\2/g, (_all, prefix, _quote, dependency) => {
      const stub = harness && dependency === './ComponentActivity' ? url('export const useComponentActivity=()=>true; export const ComponentActivityProvider=({children})=>children;')
        : harness && ['applicationState','templates','inputStateBindings','ComponentEvents'].includes(name) && dependency === 'react' ? hookUrl
        : harness && name === 'templates' ? ({'./BoundComponent':leafUrl, './RenderBoundary':url('export default ({children})=>children;'),'./useQueryRepeater':queryUrl,'./VisualStyleContext':url('export const useVisualStyles=()=>undefined;'),'./LocalizationContext':url('export const useLocalization=()=>({});'),'./useQueryPropertyBindings':url('export const useQueryPropertyBindings=()=>({});export const useQueryPropertyContext=()=>undefined;export const QueryPropertyProvider=({children})=>children;')})[dependency] : undefined;
      return prefix + JSON.stringify(stub ?? (dependency.startsWith('./') ? load(dependency.slice(2)) : pathToFileURL(require.resolve(dependency)).href));
    });
  const result = url(code); cache.set(name, result); return result;
}; }
const model = loader(), hook = loader(true);
const {resolveParameterBindings,parameterBindingState,parameterBindingStateContext,validateTemplateParameterBinding} = await import(model('templateParameterBindings'));
const {templateParameters,queryTemplateParameters,instanceRequestScope} = await import(model('templateModel'));
const {createPopup,popupQuerySource,popupSourceStatus} = await import(model('popupModel'));
const {runtimeBindingHealth} = await import(model('runtimeQuality'));
const {ProjectComponentView} = await import(hook('templates'));
const {ApplicationStateProvider,useApplicationState} = await import(hook('applicationState'));
const c = (id,type,props={}) => ({id,type,x:0,y:0,width:240,height:100,props});
const binding = (expression,references={}) => ({expression,references});
const ref = (kind,key) => binding('value',{value:{kind,key}});
const definitions = value => ({type:typeof value,value});
const field = c('note','textInput',{fieldKey:'note',defaultValue:'default'});
const save = c('save','button',{action:'script',script:'result=inputs'});
const button = c('open','button',{action:'openPopup',targetScreenId:'popup',parameters:{title:'{title}',count:'{count}'}});
const detail = {id:'detail',name:'Detail',width:300,height:200,parameters:{title:'Default',count:'1',ready:'false'},parameterTypes:{count:'number',ready:'boolean'},
  instanceState:{count:definitions(99)},components:[field,save,button,c('table','table')]};
const embed = c('child','template',{templateId:'detail',parameterBindings:{title:ref('sessionState','title'),count:ref('instanceState','count'),ready:ref('screenState','ready')}});
const parent = {id:'parent',name:'Parent',width:400,height:300,parameters:{},instanceState:{count:definitions(2),unrelated:definitions('Keep private')},components:[c('parent-label','label'),embed]};
const root = c('cards','repeater',{templateId:'parent',rows:[{id:'a',parameters:{}},{id:'b',parameters:{}}]});
const screen = {id:'main',name:'Main',width:1000,height:700,parameters:{},state:{ready:definitions(true),count:definitions(8),unused:definitions('not sent')},components:[root]};
const popupScreen = {id:'popup',name:'Popup',kind:'popup',width:600,height:400,parameters:{title:'',count:''},state:{ready:definitions(false)},components:[]};
const project = {id:'project',name:'Project',revision:1,parameters:{},sessionState:{title:definitions('Session title'),count:definitions(10),unused:definitions('not sent')},screens:[screen,popupScreen],templates:[parent,detail]};
const current = {session:{title:'{literal}',count:10,unused:'secret'},screen:{ready:true,count:8},instance:{count:2,unrelated:'private'}};
const context = {components:[embed],parameters:{title:'Parent parameter'},inputs:{},tags:[],state:current};
let passed=0; async function check(name,run){await run();passed++;console.log(`PASS ${name}`);}

await check('direct state reads the containing scopes before child state shadows equal names',()=>{
  assert.deepEqual(resolveParameterBindings(embed,detail,context),{title:'{literal}',count:2,ready:true});
  assert.equal(detail.instanceState.count.value,99);
  assert.deepEqual(parameterBindingState(embed,current),{session:{title:'{literal}'},instance:{count:2},screen:{ready:true}});
});
await check('state binding values remain literal and row values retain final precedence after type validation',()=>{
  const bound=resolveParameterBindings(embed,detail,context);
  assert.equal(templateParameters(detail,{literal:'expanded'}, {},{},bound).title,'{literal}');
  assert.equal(templateParameters(detail,{}, {},{count:'12'},bound).count,12);
  assert.equal(queryTemplateParameters(detail,{}, {},{count:13,title:'{literal}'},bound).count,13);
  assert.equal(queryTemplateParameters(detail,{}, {},{title:'{literal}'},bound).title,'{literal}');
});
await check('every declared state alias is checked even behind a lazy branch or overriding row',()=>{
  const changed={...embed,props:{...embed.props,parameterBindings:{count:binding('false ? value : 1',{value:{kind:'instanceState',key:'count'}})}}};
  for(const value of [undefined,null,[],{},NaN,Infinity,Number.MAX_SAFE_INTEGER+1,'x'.repeat(4097)]) {
    const state={...current,instance:{count:value}};
    assert.throws(()=>resolveParameterBindings(changed,detail,{...context,state}));
  }
  assert.throws(()=>resolveParameterBindings(embed,detail,{...context,state:{...current,instance:{}}}),/unavailable/);
  assert.throws(()=>templateParameters(detail,{}, {},{count:'12'},resolveParameterBindings(embed,detail,{...context,state:{...current,instance:{count:'wrong'}}})),/number/);
});
await check('authoring may defer an unknown containing screen key but runtime and private/session sources require values',()=>{
  const screenBinding=ref('screenState','future');
  assert.equal(validateTemplateParameterBinding(screenBinding,embed,[embed],{},'count','number',current,true),undefined);
  assert.match(validateTemplateParameterBinding(screenBinding,embed,[embed],{},'count','number',current),/unavailable/);
  for(const kind of ['sessionState','instanceState']) assert.match(validateTemplateParameterBinding(ref(kind,'future'),embed,[embed],{},'count','number',current,true),/unavailable/);
  assert.match(validateTemplateParameterBinding(screenBinding,embed,[embed],{},'count','number',{...current,screen:{future:null}},true),/exact finite/);
});
await check('tag parameters require a good typed live sample and root state cannot see a future child private declaration',()=>{
  const component={...embed,props:{...embed.props,parameterBindings:{count:binding('value',{value:{kind:'tag',path:'[default]Live'}})}}};
  assert.throws(()=>resolveParameterBindings(component,detail,context),/not found/);
  const tag={path:'[default]Live',quality:'Good',value:12};
  assert.deepEqual(resolveParameterBindings(component,detail,{...context,tags:[tag]}),{count:12});
  assert.throws(()=>resolveParameterBindings(component,detail,{...context,tags:[{...tag,quality:'Bad'}]}),/quality/);
  assert.throws(()=>resolveParameterBindings(component,detail,{...context,tags:[{...tag,value:'wrong'}]}),/number/);
  assert.throws(()=>resolveParameterBindings(embed,detail,{...context,state:{session:current.session,screen:current.screen}}),/instance state/);
});
await check('transport captures only referenced scope/key pairs and preserves absent state for legacy identities',()=>{
  const snapshot=parameterBindingState(embed,current),action={instanceId:'cards',instancePath:[{instanceId:'cards',rowId:'a'},{instanceId:'child'}],bindingState:[{},snapshot],bindingInputs:[{},{}],isCurrent:()=>true};
  assert.deepEqual(instanceRequestScope(action),{instancePath:action.instancePath,bindingInputs:[{},{}],bindingState:[{},snapshot]});
  assert.deepEqual(instanceRequestScope({instanceId:'legacy'}),{instanceId:'legacy'});
  assert.deepEqual(parameterBindingState(root,current),{});
  current.instance.count=3;assert.equal(snapshot.instance.count,2);current.instance.count=2;
});
await check('frozen snapshot validation rejects missing, extra, malformed and wrongly typed state without defaults',()=>{
  const snapshot=parameterBindingState(embed,current),defs={session:project.sessionState,screen:screen.state,instance:parent.instanceState};
  assert.equal(parameterBindingStateContext(embed,snapshot,defs).instance.count,2);
  for(const value of [undefined,null,[],{}, {...snapshot,unknown:{}}, {...snapshot,session:null}, {...snapshot,session:{title:'ok',extra:1}}, {...snapshot,instance:{count:'2'}}])
    assert.throws(()=>parameterBindingStateContext(embed,value,defs));
  assert.throws(()=>parameterBindingStateContext(root,{session:{}}),/unreferenced/);
  assert.deepEqual(parameterBindingStateContext(root,undefined),{session:{},screen:{}});
});

function harness(changes={}) {
  const sessions=new Map();let currentOwner,cursor,visited,effects,nodes;
  const h={project:structuredClone(project),runKey:'preview:1',actions:[],popups:[],tables:[],...changes};
  function Owner(){const document=h.project.screens[0],state=useApplicationState(h.project,document,h.runKey);h.root=state;
    return React.createElement(ApplicationStateProvider,{value:state},React.createElement(ProjectComponentView,{component:document.components[0],components:document.components,
      templates:h.project.templates,screenId:document.id,tags:[],parameters:document.parameters??{},inputs:{},scopedInputs:{},preview:true,
      onNavigate(){},onAction:(component,instance)=>h.actions.push({component,instance}),onOpenPopup:(component,instance)=>h.popups.push({component,instance}),
      onTableEdit:async(component,edit,instance)=>{h.tables.push({component,edit,instance});return{success:true};}}));}
  const hooks={useState(initial){const slots=currentOwner.slots,index=cursor++;if(!(index in slots))slots[index]=typeof initial==='function'?initial():initial;return[slots[index],next=>{slots[index]=typeof next==='function'?next(slots[index]):next;}];},
    useRef(initial){const index=cursor++;return currentOwner.slots[index]??={current:initial};},
    useEffect(run,deps){const owner=currentOwner,index=cursor++,prior=owner.effects[index];if(!prior||deps.some((value,i)=>!Object.is(value,prior.deps[i])))effects.push(()=>{prior?.cleanup?.();owner.effects[index]={deps,cleanup:run()};});}};
  function walk(node,path){if(!node||typeof node!=='object')return;if(Array.isArray(node)){node.forEach((child,index)=>walk(child,`${path}/${child?.key??index}`));return;}
    if(node.type===ApplicationStateProvider){const previous=globalThis.__parameterStateContext;globalThis.__parameterStateContext=node.props.value;walk(node.props.children,path+'/provider');globalThis.__parameterStateContext=previous;return;}
    if(typeof node.type==='function'){const key=`${path}/${node.type.name}:${node.key??''}`;visited.add(key);currentOwner=sessions.get(key)??{slots:[],effects:[]};sessions.set(key,currentOwner);cursor=0;globalThis.__parameterStateHooks=hooks;walk(node.type(node.props),key);return;}
    nodes.push(node);React.Children.toArray(node.props?.children).forEach((child,index)=>walk(child,`${path}/${child.key??index}`));}
  h.render=()=>{visited=new Set();effects=[];nodes=[];walk(React.createElement(Owner),'root');for(const[key,session]of sessions)if(!visited.has(key)){session.effects.forEach(effect=>effect?.cleanup?.());sessions.delete(key);}effects.forEach(run=>run());h.nodes=nodes;return h.leaves();};
  h.leaves=id=>h.nodes.filter(node=>node.type==='bound-leaf'&&(!id||node.props.component.id===id));
  h.stop=()=>{for(const session of sessions.values())session.effects.forEach(effect=>effect?.cleanup?.());sessions.clear();};return h;
}
await check('renderer reads immediate parent private state separately for each saved row and transmits aligned action/table/popup snapshots',async()=>{
  const h=harness();try{h.render();assert.deepEqual(h.leaves('note').map(n=>n.props.parameters.count),[2,2]);
    h.leaves('parent-label')[0].props.state.api.set('instance','count',7);h.render();assert.deepEqual(h.leaves('note').map(n=>n.props.parameters.count),[7,2]);
    assert.equal(h.leaves('note')[0].props.state.values.instance.count,99);
    h.leaves('save')[0].props.onAction();h.leaves('open')[0].props.onOpenPopup();await h.leaves('table')[0].props.onTableEdit({rowKey:'a',column:'title',value:'new'});
    for(const result of [h.actions[0],h.popups[0],h.tables[0]]) assert.deepEqual(result.instance.bindingState,[{}, {session:{title:'Session title'},instance:{count:7},screen:{ready:true}}]);
  }finally{h.stop();}
});
await check('unreferenced state preserves child edits; referenced changes reset edits and expire actions even when an expression masks the value',()=>{
  const fixture=structuredClone(project);fixture.templates[0].components[1].props.parameterBindings.count.expression='value > 0 ? 1 : 0';
  const h=harness({project:fixture});try{h.render();h.leaves('note')[0].props.onInputChange('note','edited');h.render();
    h.leaves('save')[0].props.onAction();const old=h.actions[0].instance,oldLeaf=h.leaves('note')[0];
    h.leaves('parent-label')[0].props.state.api.set('instance','unrelated','changed');h.render();assert.equal(h.leaves('note')[0].props.inputs.note,'edited');assert.equal(old.isCurrent(),true);
    h.leaves('parent-label')[0].props.state.api.set('instance','count',3);h.render();assert.equal(h.leaves('note')[0].props.parameters.count,1);assert.equal(h.leaves('note')[0].props.inputs.note,'default');assert.equal(old.isCurrent(),false);
    oldLeaf.props.onInputChange('note','late');oldLeaf.props.state.api.set('session','count',88);h.render();assert.equal(h.leaves('note')[0].props.inputs.note,'default');assert.equal(h.root.api.get('session','count'),10);
    assert.equal(h.leaves('note')[1].props.parameters.count,1);
  }finally{h.stop();}
});
await check('a saved row overlay cannot hide a changed source lifetime and old action closures remain expired',()=>{
  const fixture=structuredClone(project),child=fixture.templates[0].components[1];child.type='repeater';child.props.rows=[{id:'fixed',parameters:{count:'42'}}];
  const h=harness({project:fixture});try{h.render();h.leaves('note')[0].props.onInputChange('note','draft');h.leaves('save')[0].props.onAction();const old=h.actions[0].instance;
    h.leaves('parent-label')[0].props.state.api.set('instance','count',5);h.render();assert.equal(h.leaves('note')[0].props.parameters.count,42);assert.equal(h.leaves('note')[0].props.inputs.note,'default');assert.equal(old.isCurrent(),false);
  }finally{h.stop();}
});
await check('shared state snapshots agree across levels and changes invalidate every dependent descendant',()=>{
  const fixture=structuredClone(project);fixture.templates[0].parameters.title='Default';fixture.screens[0].components[0].props.parameterBindings={title:ref('sessionState','title')};
  const h=harness({project:fixture});try{h.render();h.leaves('save')[0].props.onAction();assert.equal(h.actions[0].instance.bindingState[0].session.title,'Session title');
    assert.equal(h.actions[0].instance.bindingState[1].session.title,'Session title');const old=h.actions[0].instance;
    h.root.api.set('session','title','Changed');h.root.api.set('screen','ready',false);h.render();h.leaves('save')[0].props.onAction();const next=h.actions[1].instance;
    assert.equal(old.isCurrent(),false);assert.equal(next.parameters.title,'Changed');assert.equal(next.parameters.ready,false);assert.equal(next.bindingState[0].session.title,next.bindingState[1].session.title);
  }finally{h.stop();}
});
await check('bad containing state blocks all descendants and health uses available parent state without inventing child state',()=>{
  const fixture=structuredClone(project);fixture.screens[0].components=[{...structuredClone(embed),props:{...structuredClone(embed.props),parameterBindings:{count:ref('screenState','count')}}}];
  assert.equal(runtimeBindingHealth(fixture.screens[0],fixture.templates,[],{}, {},false,current).badCount,0);
  assert.equal(runtimeBindingHealth(fixture.screens[0],fixture.templates,[],{}, {},false,{...current,screen:{count:Infinity}}).badCount,1);
  fixture.screens[0].components[0].props.parameterBindings.count=ref('instanceState','count');const h=harness({project:fixture});try{h.render();assert.equal(h.leaves().length,0);assert.ok(h.nodes.some(node=>node.props?.className?.includes('query-repeater-error')));}finally{h.stop();}
});
await check('query stable-ID reorder preserves local edits while a row-masked state-source change resets the complete row context',()=>{
  const fixture=structuredClone(project),host=fixture.screens[0].components[0];fixture.templates[0].parameters.title='Default';
  delete host.props.rows;host.props.rowsSource={queryId:'records',rowKey:'id',parameterMap:{title:'title'}};host.props.parameterBindings={title:ref('sessionState','title')};
  globalThis.__parameterQuery={rows:[{id:'a',parameters:{title:'Row A'}},{id:'b',parameters:{title:'Row B'}}],key:'records',loading:false,error:''};
  const h=harness({project:fixture});try{h.render();h.leaves('note')[0].props.onInputChange('note','draft A');h.render();globalThis.__parameterQuery.rows.reverse();h.render();
    assert.deepEqual(h.leaves('note').map(n=>n.props.inputs.note),['default','draft A']);h.leaves('save')[1].props.onAction();const old=h.actions[0].instance;
    assert.equal(old.querySourceParameters.title,'Row A');h.root.api.set('session','title','Changed binding hidden by row');h.render();
    assert.deepEqual(h.leaves('note').map(n=>n.props.inputs.note),['default','default']);assert.equal(old.isCurrent(),false);
    h.leaves('save')[1].props.onAction();assert.equal(h.actions[1].instance.querySourceParameters.title,'Row A');assert.equal(h.actions[1].instance.bindingState[0].session.title,'Changed binding hidden by row');
  }finally{h.stop();}
});

function popupFixture(query=false){
  const fixture=structuredClone(project),host=fixture.screens[0],outer=fixture.templates[0],inner=fixture.templates[1];
  const top=host.components[0];if(query){delete top.props.rows;top.props.rowsSource={queryId:'records',rowKey:'id',parameterMap:{title:'title'}};outer.parameters.title='Default';}
  const state=[{},parameterBindingState(embed,current)],row={id:'a',parameters:query?{title:'Database'}:{}};
  const base=query?queryTemplateParameters(outer,{}, {},row.parameters):templateParameters(outer,{});
  const parameters=templateParameters(inner,base,{}, {},resolveParameterBindings(outer.components[1],inner,{...context,parameters:base}));
  const action={instanceId:'cards',rowId:'a',instancePath:[{instanceId:'cards',rowId:'a'},{instanceId:'child'}],template:inner,parameters,inputs:{},bindingInputs:[{},{}],bindingState:state,...(query?{querySourceParameters:base}:{})};
  const popup=createPopup(fixture,host,button,{},parameters,action);return{fixture,popup,action,row};
}
const rows = row => ({rows:[row],loading:false,error:''});
await check('open popup retains a deep opening state snapshot independent of later opener and popup form state',()=>{
  const {fixture,popup,action}=popupFixture();action.bindingState[1].instance.count=88;action.bindingState[1].screen.ready=false;
  assert.equal(popup.origin.bindingState[1].instance.count,2);assert.equal(popup.parameters.count,'2');assert.equal(popupQuerySource(fixture,popup).error,'');
  assert.equal(fixture.screens[1].state.ready.value,false);assert.equal(popupSourceStatus(popup,popupQuerySource(fixture,popup),{rows:[],loading:false,error:''}).ready,true);
});
await check('popup source declaration changes invalidate snapshots while unrelated declarations do not',()=>{
  for(const change of [p=>{p.sessionState.title.type='number';},p=>{p.screens[0].state.ready.value=false;},p=>{p.templates[0].instanceState.count.value=9;},p=>{delete p.templates[0].instanceState.count;}]) {
    const {fixture,popup}=popupFixture();change(fixture);assert.ok(popupQuerySource(fixture,popup).error);
  }
  const {fixture,popup}=popupFixture();fixture.sessionState.unused.value='unrelated';fixture.screens[0].state.unused.value='unrelated';assert.equal(popupQuerySource(fixture,popup).error,'');
});
await check('malformed or omitted popup state context fails closed rather than substituting declared defaults',()=>{
  const {fixture,popup}=popupFixture();
  for(const bindingState of [undefined,null,{},[],[{}],[{},{}],[{}, {session:{title:'ok'},screen:{ready:true},instance:{count:'2'}}],[{screen:{}},popup.origin.bindingState[1]]]) {
    const changed={...popup,origin:{...popup.origin,bindingState}};assert.ok(popupQuerySource(fixture,changed).error,JSON.stringify(bindingState));
  }
});
await check('query popup rechecks current records using captured state and detects changed or removed records',()=>{
  const {fixture,popup,action,row}=popupFixture(true),definition=popupQuerySource(fixture,popup);
  assert.equal(definition.error,'');assert.equal(popupSourceStatus(popup,definition,rows(row)).ready,true);
  action.bindingState[1].session.title='new background title';assert.equal(popupSourceStatus(popup,popupQuerySource(fixture,popup),rows(row)).ready,true);
  assert.equal(popupSourceStatus(popup,definition,rows({...row,parameters:{title:'Changed record'}})).stale,true);
  assert.equal(popupSourceStatus(popup,definition,{rows:[],loading:false,error:''}).stale,true);
});
await check('conflicting shared state values in one captured source path are rejected independently of private values',()=>{
  const {fixture,popup}=popupFixture();fixture.templates[0].parameters.title='Default';fixture.screens[0].components[0].props.parameterBindings={title:ref('sessionState','title')};
  delete popup.templateSourceSignature;popup.origin.bindingState[0]={session:{title:'different'}};
  assert.match(popupQuerySource(fixture,popup).error,/conflicting/);
  popup.origin.bindingState[0].session.title='{literal}';assert.equal(popupQuerySource(fixture,popup).error,'');
});
console.log(`${passed} template parameter state checks passed.`);
