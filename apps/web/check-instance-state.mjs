import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';

process.on('uncaughtException',error=>{console.error(error.stack?.split('\n').filter(line=>!line.includes('data:')).join('\n')??error.message);process.exit(1);});
process.on('unhandledRejection',error=>{console.error(error?.message??error);process.exit(1);});
const require=createRequire(import.meta.url),moduleUrl=code=>'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
const reactUrl=pathToFileURL(require.resolve('react')).href;
const hookUrl=moduleUrl(`export * from ${JSON.stringify(reactUrl)};
export const useContext=()=>globalThis.__instanceContext;
export const useState=value=>globalThis.__instanceHooks.useState(value);
export const useRef=value=>globalThis.__instanceHooks.useRef(value);
export const useEffect=(run,deps)=>globalThis.__instanceHooks.useEffect(run,deps);`);
const leafUrl=moduleUrl(`import React from ${JSON.stringify(reactUrl)};export default function BoundComponent(props){return React.createElement('bound-leaf',{...props,state:globalThis.__instanceContext});}`);
const queryUrl=moduleUrl('export const useQueryRepeater=source=>source?globalThis.__instanceQuery:{rows:[],key:"none",loading:false,error:""};');
function loader(harness=false){const cache=new Map();return function load(name){
  if(cache.has(name))return cache.get(name);
  const file=['tsx','ts'].map(ext=>new URL(`src/${name}.${ext}`,import.meta.url)).find(file=>fs.existsSync(file));assert.ok(file,name);
  const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText
    .replace(/import "\.\/[^"\n]+\.css";\r?\n/g,'')
    .replace(/(from\s+|import\s+)(["'])([^"']+)\2/g,(_all,prefix,_quote,dependency)=>{
      const stub=harness&&['applicationState','templates','inputStateBindings','ComponentEvents'].includes(name)&&dependency==='react'?hookUrl
        :harness&&name==='templates'?({'./BoundComponent':leafUrl,'./useQueryRepeater':queryUrl,'./VisualStyleContext':moduleUrl('export const useVisualStyles=()=>undefined;'),'./LocalizationContext':moduleUrl('export const useLocalization=()=>({});'),'./useQueryPropertyBindings':moduleUrl('export const useQueryPropertyBindings=()=>({});export const useQueryPropertyContext=()=>undefined;export const QueryPropertyProvider=({children})=>children;')})[dependency]:undefined;
      return prefix+JSON.stringify(stub??(dependency.startsWith('./')?load(dependency.slice(2)):pathToFileURL(require.resolve(dependency)).href));
    });
  const result=moduleUrl(code);cache.set(name,result);return result;
};}
const model=loader(),hook=loader(true);
const {ApplicationStateStore,stateDefaults}=await import(model('applicationStateModel'));
const {InputStateBindingForm}=await import(model('inputStateBindings'));
const {InputEventLifecycle}=await import(model('inputEvents'));
const {evaluateComponentBindings}=await import(model('propertyBindings'));
const {resolveParameterBindings}=await import(model('templateParameterBindings'));
const {runtimeBindingHealth}=await import(model('runtimeQuality'));
const {ProjectComponentView}=await import(hook('templates'));
const {ApplicationStateProvider,useApplicationState,usePopupApplicationState}=await import(hook('applicationState'));
const realState=await import(model('applicationState')),realTemplates=await import(model('templates'));
const defs={count:{type:'number',value:2},note:{type:'string',value:'Ready'},enabled:{type:'boolean',value:true}};
const shared={count:{type:'number',value:10}};
const c=(id,type,props={})=>({id,type,x:0,y:0,width:240,height:100,props});
const field=c('count','spinner',{fieldKey:'count',min:0,max:10,defaultValue:8,stateBinding:{scope:'instance',key:'count'}});
const save=c('save','button',{action:'script',script:'result=inputs'});
const label=c('label','label',{bindings:{text:{expression:'n',references:{n:{kind:'instanceState',key:'count'}}}}});
const template={id:'card',name:'Card',width:300,height:200,parameters:{machine:'A'},instanceState:defs,components:[field,label,save]};
const repeat=c('cards','repeater',{templateId:'card',rows:[{id:'a',parameters:{}},{id:'b',parameters:{}}]});
const screen={id:'main',name:'Main',width:1000,height:700,parameters:{},state:shared,components:[repeat]};
const project={id:'project',revision:1,name:'Project',parameters:{},sessionState:shared,screens:[screen],templates:[template]};
const own=()=>{const store=new ApplicationStateStore();store.configure('project:1',shared);const screen=store.activateScreen('main',shared);return{store,screen};};
let passed=0;async function check(name,run){await run();passed++;console.log(`PASS ${name}`);}

function harness(changes={}){
  const sessions=new Map();let current,cursor,visited,effects,nodes;
  const h={project:structuredClone(project),runKey:'preview:1',preview:true,actions:[],...changes};
  function Owner(){const document=h.project.screens[0],state=useApplicationState(h.project,document,h.runKey,h.previewDefinitions);h.root=state;
    return React.createElement(ApplicationStateProvider,{value:state},React.createElement(ProjectComponentView,{component:document.components[0],components:document.components,
      templates:h.project.templates,screenId:document.id,tags:[],parameters:document.parameters??{},inputs:{},scopedInputs:{},preview:h.preview,publishedAt:h.publishedAt,
      onNavigate(){},onAction:(component,instance)=>h.actions.push({component,instance})}));}
  const hooks={
    useState(initial){const slots=current.slots,index=cursor++;if(!(index in slots))slots[index]=typeof initial==='function'?initial():initial;return[slots[index],next=>{slots[index]=typeof next==='function'?next(slots[index]):next;}];},
    useRef(initial){const index=cursor++;return current.slots[index]??={current:initial};},
    useEffect(run,deps){const owner=current,index=cursor++,prior=owner.effects[index];if(!prior||deps.some((value,i)=>!Object.is(value,prior.deps[i])))effects.push(()=>{prior?.cleanup?.();owner.effects[index]={deps,run,cleanup:run()};});},
  };
  function walk(node,path){
    if(!node||typeof node!=='object')return;
    if(Array.isArray(node)){node.forEach((child,index)=>walk(child,`${path}/${child?.key??index}`));return;}
    if(node.type===ApplicationStateProvider){const prior=globalThis.__instanceContext;globalThis.__instanceContext=node.props.value;walk(node.props.children,path+'/provider');globalThis.__instanceContext=prior;return;}
    if(typeof node.type==='function'){const key=`${path}/${node.type.name}:${node.key??''}`;visited.add(key);current=sessions.get(key)??{slots:[],effects:[]};sessions.set(key,current);cursor=0;globalThis.__instanceHooks=hooks;walk(node.type(node.props),key);return;}
    nodes.push(node);React.Children.toArray(node.props?.children).forEach((child,index)=>walk(child,`${path}/${child.key??index}`));
  }
  h.render=()=>{visited=new Set();effects=[];nodes=[];walk(React.createElement(Owner),'root');for(const[key,session]of sessions)if(!visited.has(key)){session.effects.forEach(effect=>effect?.cleanup?.());sessions.delete(key);}effects.forEach(run=>run());h.nodes=nodes;return h.leaves();};
  h.leaves=id=>h.nodes.filter(node=>node.type==='bound-leaf'&&(!id||node.props.component.id===id));
  h.stop=()=>{for(const session of sessions.values())session.effects.forEach(effect=>effect?.cleanup?.());sessions.clear();};
  h.strictReplay=()=>{for(const session of sessions.values())session.effects.forEach(effect=>effect?.cleanup?.());for(const session of sessions.values())session.effects.forEach(effect=>{if(effect)effect.cleanup=effect.run();});};
  return h;
}

await check('private scopes isolate equal names, share screen/session, and expose no instance scope on root',()=>{
  const {store,screen}=own(),a=store.createScope('a',defs),b=store.createScope('b',defs),first=store.context(screen,a),second=store.context(screen,b);
  first.api.set('instance','count',7);first.api.set('session','count',11);first.api.set('screen','count',12);
  assert.equal(second.api.get('instance','count'),2);assert.equal(second.api.get('session','count'),11);assert.equal(second.api.get('screen','count'),12);
  assert.throws(()=>first.api.set('instance','count','7'));assert.throws(()=>first.api.set('instance','missing',1));
  assert.throws(()=>store.context(screen).api.get('instance','count'),/outside a template/);assert.equal(store.context(screen).values.instance,undefined);
  first.api.reset('instance');assert.deepEqual(store.context(screen,a).values.instance,stateDefaults(defs));assert.equal(first.api.get('screen','count'),12);
  assert.ok(Object.isFrozen(store.context(screen,a).values.instance));assert.deepEqual(defs.count,{type:'number',value:2});
});
await check('nested private scopes replace parent visibility and all shared writes expire when any ancestor closes',()=>{
  const {store,screen}=own(),parent=store.createScope('parent',{parentOnly:{type:'string',value:'private'},...defs}),child=store.createScope('child',defs);
  const p=store.context(screen,parent),n=store.context(screen,child,p.ownerScopes);
  p.api.set('instance','count',9);assert.equal(n.api.get('instance','count'),2);assert.throws(()=>n.api.get('instance','parentOnly'),/not declared/);
  n.api.set('instance','count',4);assert.equal(p.api.get('instance','count'),9);
  store.closeScope(parent);n.api.set('instance','count',6);n.api.set('session','count',99);n.api.set('screen','count',99);n.api.reset('screen');
  assert.equal(n.api.get('instance','count'),undefined);assert.equal(store.context(screen).api.get('session','count'),10);assert.equal(store.context(screen).api.get('screen','count'),10);
  store.resumeScope(parent);assert.equal(n.api.get('session','count'),undefined);
});
await check('saved repeater rows own separate accepted values and same-value reset clears only their transient draft',()=>{
  const h=harness();try{h.render();const a=h.leaves('count')[0];a.props.onInputChange('count',7);h.render();assert.deepEqual(h.leaves('count').map(n=>n.props.inputs.count),[7,2]);
    h.leaves('count')[0].props.onInputChange('count','');h.render();assert.deepEqual(h.leaves('count').map(n=>n.props.inputs.count),['',2]);
    h.leaves('count')[0].props.state.api.reset('instance','count');h.render();assert.deepEqual(h.leaves('count').map(n=>n.props.inputs.count),[2,2]);
    h.leaves('count')[0].props.onInputChange('count','');h.render();h.leaves('count')[0].props.state.api.reset('instance','count');h.render();assert.equal(h.leaves('count')[0].props.inputs.count,2);
    h.leaves('save')[0].props.onAction();assert.deepEqual(h.actions[0].instance.inputs,{count:2});assert.equal('instanceState' in h.actions[0].instance,false);
  }finally{h.stop();}
});
await check('saved row reorder preserves identity, while removal and reinsertion reset private state and captured APIs',()=>{
  const h=harness();try{h.render();h.leaves('count')[0].props.onInputChange('count',6);h.render();const old=h.leaves('count')[0].props.state.api;
    const rows=h.project.screens[0].components[0].props.rows;rows.reverse();h.render();assert.deepEqual(h.leaves('count').map(n=>n.props.inputs.count),[2,6]);
    rows.pop();h.render();old.set('session','count',99);assert.equal(old.get('instance','count'),undefined);assert.equal(h.root.api.get('session','count'),10);
    rows.push({id:'a',parameters:{}});h.render();assert.deepEqual(h.leaves('count').map(n=>n.props.inputs.count),[2,2]);
  }finally{h.stop();}
});
await check('query stable-ID reorder retains private values; changed record context and replacement reset them',()=>{
  const fixture=structuredClone(project);fixture.screens[0].components[0].props={templateId:'card',rowsSource:{queryId:'records',rowKey:'id',parameterMap:{machine:'machine'}}};
  globalThis.__instanceQuery={rows:[{id:'a',parameters:{machine:'A'}},{id:'b',parameters:{machine:'B'}}],key:'q',loading:false,error:''};
  const h=harness({project:fixture});try{h.render();h.leaves('count')[0].props.onInputChange('count',8);h.render();globalThis.__instanceQuery.rows.reverse();h.render();assert.deepEqual(h.leaves('count').map(n=>n.props.inputs.count),[2,8]);
    globalThis.__instanceQuery.rows[1]={id:'a',parameters:{machine:'Replacement'}};h.render();assert.deepEqual(h.leaves('count').map(n=>n.props.inputs.count),[2,2]);
  }finally{h.stop();}
});
await check('static parameter, template default, instance default and Preview mode changes reset unbound private forms',()=>{
  const h=harness();try{h.render();for(const change of[
    ()=>{h.project.screens[0].components[0].props.parameters={machine:'B'};},
    ()=>{h.project.templates[0].parameters.machine='C';delete h.project.screens[0].components[0].props.parameters;},
    ()=>{h.project.templates[0].instanceState.note.value='Updated';},
    ()=>{h.preview=false;},()=>{h.preview=true;},()=>{h.runKey='preview:2';},
    ()=>{h.publishedAt='publication:2';},
  ]){h.leaves('count')[0].props.state.api.set('instance','count',9);h.render();const previous=h.leaves('count')[0].props.state.api;change();h.render();assert.equal(h.leaves('count')[0].props.inputs.count,2);assert.equal(previous.get('session','count'),undefined);}}
  finally{h.stop();}
});
await check('nested rendered templates have their own state instead of inheriting the caller private map',()=>{
  const fixture=structuredClone(project);fixture.templates[0].instanceState.parentOnly={type:'string',value:'hidden'};
  fixture.templates[0].components.push(c('nested','template',{templateId:'inner'}));fixture.templates.push({...structuredClone(template),id:'inner',instanceState:{...structuredClone(defs),count:{type:'number',value:4}}});
  const h=harness({project:fixture});try{h.render();assert.deepEqual(h.leaves('count').map(n=>n.props.inputs.count),[2,4,2,4]);
    h.leaves('count')[0].props.onInputChange('count',7);h.leaves('count')[1].props.onInputChange('count',8);h.render();assert.deepEqual(h.leaves('count').map(n=>n.props.inputs.count),[7,8,2,4]);
    assert.throws(()=>h.leaves('count')[1].props.state.api.get('instance','parentOnly'),/not declared/);
  }finally{h.stop();}
});
await check('StrictMode replay expires captured instance and shared helpers but preserves current private values',()=>{
  const h=harness();try{h.render();h.leaves('count')[0].props.onInputChange('count',6);h.render();const old=h.leaves('count')[0].props.state.api;
    h.strictReplay();h.render();old.set('instance','count',9);old.set('screen','count',99);old.set('session','count',99);
    assert.equal(old.get('instance','count'),undefined);assert.equal(h.leaves('count')[0].props.inputs.count,6);assert.equal(h.root.api.get('screen','count'),10);assert.equal(h.root.api.get('session','count'),10);
    h.leaves('count')[0].props.onInputChange('count',5);h.render();assert.equal(h.leaves('count')[0].props.inputs.count,5);
  }finally{h.stop();}
});
await check('instance fx and child parameter bindings use only the immediately containing typed values',()=>{
  const {store,screen}=own(),instance=store.createScope('card',defs),context=store.context(screen,instance);context.api.set('instance','count',7);
  const result=evaluateComponentBindings(label,{components:[label],parameters:{},inputs:{},tags:[],communicationLost:true,state:store.context(screen,instance).values});assert.equal(result.component.props.text,'7');assert.deepEqual(result.errors,{});
  const missing=evaluateComponentBindings(label,{components:[label],parameters:{},inputs:{},tags:[],state:store.context(screen).values});assert.match(missing.errors.text,/Instance state/);
  const bound=c('bound','template',{templateId:'card',parameterBindings:{machine:{expression:'n',references:{n:{kind:'instanceState',key:'count'}}}}});
  assert.equal(resolveParameterBindings(bound,template,{components:[bound],parameters:{},inputs:{},tags:[],state:context.values}).machine,'2');
  assert.throws(()=>resolveParameterBindings(bound,template,{components:[bound],parameters:{},inputs:{},tags:[],state:store.context(screen).values}),/unavailable/);
});
await check('asynchronous input scripts cannot mutate their disposed private or shared scopes',async()=>{
  const {store,screen}=own(),instance=store.createScope('card',defs),context=store.context(screen,instance);let captured,finish;
  const control={...field,props:{...field.props,events:{change:{language:'javascript',code:'script'}}}};
  const lifecycle=new InputEventLifecycle(async(_script,_event,_inputs,_parameters,app)=>{captured=app;await new Promise(resolve=>{finish=resolve;});app.state.set('instance','count',8);app.state.set('session','count',88);app.state.set('screen','count',88);});
  lifecycle.activate();lifecycle.setContext({key:context.key,component:control,components:[control],inputs:{count:2},parameters:{},setInput(){},notify(){},error(){},state:context.api},2);lifecycle.change(3);
  await Promise.resolve();assert.ok(captured);store.closeScope(instance);finish();await lifecycle.whenIdle();assert.equal(store.context(screen).api.get('session','count'),10);assert.equal(store.context(screen).api.get('screen','count'),10);lifecycle.deactivate();
});
await check('private defaults appear in real rendering and health without leaking an enclosing live instance map',()=>{
  const store=new ApplicationStateStore();store.configure('preview',shared);const scope=store.activateScreen('main',shared);
  const outer=store.createScope('outer',{count:{type:'number',value:9}});
  const html=renderToStaticMarkup(React.createElement(realState.ApplicationStateProvider,{value:{...store.context(scope,outer),store}},React.createElement(realTemplates.ProjectComponentView,{component:repeat,components:[repeat],templates:[template],screenId:'main',tags:[],parameters:{},inputs:{},preview:true,onNavigate(){}})));
  assert.match(html,/>2</);assert.doesNotMatch(html,/Binding error/);
  assert.deepEqual(runtimeBindingHealth(screen,[template],[],{}, {},false,store.context(scope,outer).values),{badCount:0,simulated:false,unknownCount:1});
});

// Hook-only owners make Preview and popup lifetimes independently observable.
function hookHarness(){const slots=[],effects=[];let cursor=0;const hooks={useRef(initial){return slots[cursor++]??={current:initial};},useState(initial){const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return[slots[i],next=>{slots[i]=typeof next==='function'?next(slots[i]):next;}];},useEffect(run,deps){const i=cursor++,old=slots[i];if(!old||deps.some((v,j)=>!Object.is(v,old.deps[j]))){old?.cleanup?.();slots[i]={deps,cleanup:run()};effects.push(slots[i]);}}};return{render(run){cursor=0;globalThis.__instanceHooks=hooks;return run();},stop(){effects.forEach(effect=>effect.cleanup?.());}};}
await check('shared-template Preview has private defaults and switching back to a root screen removes that scope',()=>{
  const h=hookHarness();try{const first=h.render(()=>useApplicationState(project,screen,'preview',defs));first.api.set('instance','count',6);
    const same=h.render(()=>useApplicationState(project,screen,'preview',structuredClone(defs)));assert.equal(same.api.get('instance','count'),6);
    const root=h.render(()=>useApplicationState(project,screen,'preview'));assert.equal(root.values.instance,undefined);assert.equal(first.api.get('session','count'),undefined);
    const back=h.render(()=>useApplicationState(project,screen,'preview',defs));assert.equal(back.api.get('instance','count'),2);
  }finally{h.stop();}
});
await check('popup hook never inherits caller private state and popup close disposes descendant shared helpers',()=>{
  const {store,screen}=own(),instance=store.createScope('caller',defs),parent={...store.context(screen,instance),store},h=hookHarness();
  const popup=h.render(()=>usePopupApplicationState(parent,'popup',shared));assert.equal(popup.values.instance,undefined);
  const child=store.createScope('popup-child',defs),childContext=store.context(popup.screenScope,child,popup.ownerScopes);childContext.api.set('instance','count',6);
  h.stop();childContext.api.set('session','count',99);assert.equal(childContext.api.get('instance','count'),undefined);assert.equal(parent.api.get('session','count'),10);assert.equal(parent.api.get('instance','count'),2);
});

delete globalThis.__instanceHooks;delete globalThis.__instanceContext;delete globalThis.__instanceQuery;
console.log(`${passed} instance-state checks passed.`);
