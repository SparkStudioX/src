import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import React from 'react';
import ts from 'typescript';
import { createTestModuleFiles } from './test-module-files.mjs';

// Authored component behavior checks. No gateway, source credentials or browser data.
const storage=new Map();globalThis.localStorage={getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)};globalThis.window={innerWidth:1000};globalThis.requestAnimationFrame=run=>run();
const file=createTestModuleFiles(),modules=new Map(),require=createRequire(import.meta.url);
const hooksUrl=file(`let stores=new Map(),scope='',index=0;export const begin=name=>{scope=name;index=0;if(!stores.has(name))stores.set(name,[]);};export const clear=()=>stores.clear();export const useState=initial=>{const values=stores.get(scope),at=index++;if(!(at in values))values[at]=typeof initial==='function'?initial():initial;return[values[at],next=>{values[at]=typeof next==='function'?next(values[at]):next;}];};export const useRef=initial=>useState({current:initial})[0];export const useMemo=run=>run();export const useCallback=run=>run;export const useEffect=()=>{};export const useId=()=>scope+'-'+index++;`);
modules.set('api',file('export const displayValue=value=>JSON.stringify(value??null);export const api=()=>Promise.resolve({items:[]});'));
function load(name){if(modules.has(name))return modules.get(name);if(name.endsWith('.json')){const value=JSON.parse(fs.readFileSync(new URL('src/'+name,import.meta.url),'utf8')),url=file('export default '+JSON.stringify(value)+';');modules.set(name,url);return url;}const source=['ts','tsx'].map(extension=>new URL(`src/${name}.${extension}`,import.meta.url)).find(path=>fs.existsSync(path));assert.ok(source,name);const code=ts.transpileModule(fs.readFileSync(source,'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText.replace(/import\s+["'][^"']+\.css["'];?/g,'').replace(/from (["'])([^"']+)\1/g,(_match,_quote,dependency)=>`from ${JSON.stringify(dependency==='react'?hooksUrl:dependency.startsWith('./')?load(dependency.slice(2)):pathToFileURL(require.resolve(dependency)).href)}`);const url=file(code);modules.set(name,url);return url;}
const hooks=await import(hooksUrl),{default:ModelBuilder}=await import(load('modelBuilder')),{default:Library}=await import(load('modelBuilderLibrary')),{default:Toolbar}=await import(load('modelBuilderToolbar')),{BuilderMemberEditor}=await import(load('modelBuilderDrawer')),{emptyModelPackage}=await import(load('modelWorkspace'));
const render=(element,scope=element.type.name)=>{hooks.begin(scope);return element.type(element.props);};
const nodes=node=>!node||typeof node!=='object'?[]:[node,...React.Children.toArray(node.props?.children).flatMap(nodes)];
const content=node=>typeof node==='string'||typeof node==='number'?String(node):!node?'':React.Children.toArray(node.props?.children).map(content).join('');
const button=(tree,label)=>{const match=nodes(tree).find(node=>node.type==='button'&&content(node)===label);assert.ok(match,`button ${label}`);return match;};
const component=(tree,name)=>{const match=nodes(tree).find(node=>node.type?.name===name);assert.ok(match,`component ${name}`);return match;};
const definitions=['Press01','Press02','Press03'].flatMap(name=>['Speed','Count'].map((leaf,index)=>({path:`[default]Equipment/${name}/${leaf}`,kind:'memory',dataType:index?'Int64':'Double',unit:index?'parts':'rpm',value:0})));
const blank={id:'Press',version:1,members:[],parameters:[]};
function workspace({types=[blank],savedTypes=[],instances=[],sources=definitions,fromAskSpark=[],disabled=false,hasChanges=true}={}){
  hooks.clear();storage.clear();let model={...emptyModelPackage(),udtDefinitions:structuredClone(types),instances:structuredClone(instances)},selectedType=types[0]?`${types[0].id}@${types[0].version}`:"",tree;const savedModel={...emptyModelPackage(),udtDefinitions:savedTypes},announcements=[],actions=[];
  const update=()=>{hooks.begin('builder');tree=ModelBuilder({model,savedModel,definitions:sources,tags:[],connections:[],selectedType,fromAskSpark,disabled,hasChanges,onUseStarter:()=>actions.push("starter"),onReview:()=>actions.push("review"),onVerify:path=>actions.push(["verify",path]),onIssues:path=>actions.push(["issues",path]),onSelectType:key=>{selectedType=key;},onChange:next=>{model=next;},onAnnounce:text=>announcements.push(text)});return tree;};
  update();return {get model(){return model;},get tree(){return tree;},get selectedType(){return selectedType;},announcements,actions,render:update,toolbar:()=>render(component(tree,"ModelBuilderToolbar"),"toolbar"),panels:()=>component(tree,'ModelBuilderPanels').props,library:()=>component(tree,'ModelBuilderPanels').props.library.props,shell:()=>render(nodes(tree).some(node=>node.type?.name==='ModelBuilderPanels')?component(tree,'ModelBuilderPanels').props.shell:component(tree,'BuilderShellController'),'controller'),instances:()=>render(component(tree,'ModelBuilderPanels').props.instances,'grid')};
}
let passed=0;const check=(name,run)=>{run();passed++;console.log(`PASS ${name}`);};
check('saved types cannot be edited or receive drops; new versions retain pinned instances',()=>{
  const type={...blank,members:[{path:'Speed',kind:'reference',dataType:'Double',target:definitions[0].path}]},instance={path:'[default]Models/Press01',definitionId:'Press',version:1};const view=workspace({types:[type],savedTypes:[type],instances:[instance]});
  assert.equal(view.shell().props.saved,true);view.library().onAdd({kind:'tag',path:definitions[1].path});assert.equal(view.model.udtDefinitions[0].members.length,1);assert.match(view.announcements.at(-1),/editable draft/);
  view.shell().props.onEditVersion();view.render();assert.equal(view.selectedType,'Press@2');assert.equal(view.model.instances[0].version,1);assert.equal(view.shell().props.saved,false);assert.equal(view.model.udtDefinitions.length,2);
});
check('folder drop parameterization and first instance are one combined draft edit',()=>{
  const view=workspace();view.library().onAdd({kind:'folder',path:'[default]Equipment/Press01'});view.render();assert.equal(view.model.udtDefinitions[0].members.length,2);component(view.tree,'ParameterizeDialog').props.onAccept('Machine');view.render();
  const type=view.model.udtDefinitions[0];assert.deepEqual(type.parameters,[{name:'Machine',type:'String',required:true}]);assert.equal(type.members[0].target,'[default]Equipment/{Machine}/Count');assert.equal(view.model.instances[0].parameters.Machine,'Press01');assert.ok(view.panels().instances.props.suggestions.length>=2);
});
check('declining parameterization keeps literal references and reopening preserves work',()=>{
  const view=workspace();view.library().onAdd({kind:'folder',path:'[default]Equipment/Press01'});view.render();component(view.tree,'ParameterizeDialog').props.onClose();view.render();assert.ok(!nodes(view.tree).some(node=>node.type?.name==='ParameterizeDialog'));assert.equal(view.model.instances.length,0);assert.match(view.model.udtDefinitions[0].members[0].target,/Press01/);view.shell().props.onParameterize();view.render();assert.ok(component(view.tree,'ParameterizeDialog'));
});
check('Find matching folders reconstructs suggestions without any existing instances',()=>{
  const type={...blank,parameters:[{name:'Device',type:'String',required:true}],members:[{path:'Speed',kind:'reference',dataType:'Double',target:'[default]Equipment/{Device}/Speed'}]},view=workspace({types:[type]});view.panels().instances.props.onFindFolders();view.render();component(view.tree,'FindFolderDialog').props.onFind('[default]Equipment/Press01');view.render();assert.ok(view.panels().instances.props.suggestions.length>=2);assert.equal(view.model.instances.length,0);assert.equal(view.model.udtDefinitions[0].parameters.length,1);
});
check('in-type badges include concrete targets resolved from parameterized instances',()=>{
  const type={...blank,parameters:[{name:'Device',type:'String',required:true}],members:[{path:'Speed',kind:'reference',dataType:'Double',target:'[default]Equipment/{Device}/Speed'}]},view=workspace({types:[type],instances:[{path:'[default]Models/P1',definitionId:'Press',version:1,parameters:{Device:'Press01'}}]});assert.ok(view.library().usedTargets.has('[default]Equipment/Press01/Speed'));assert.ok(!view.library().usedTargets.has('[default]Equipment/Press02/Speed'));
});
check('reference replacement confirms type changes and cancel leaves target untouched',()=>{
  const type={...blank,members:[{path:'Speed',kind:'reference',target:definitions[0].path,dataType:'Double'}]};const view=workspace({types:[type]});view.shell().props.onDrop({kind:'tag',path:definitions[1].path},0,true);view.render();assert.equal(view.model.udtDefinitions[0].members[0].target,definitions[0].path);component(view.tree,'BuilderDialog').props.onClose();view.render();assert.equal(view.model.udtDefinitions[0].members[0].dataType,'Double');
  view.shell().props.onDrop({kind:'tag',path:definitions[1].path},0,true);view.render();button(component(view.tree,'BuilderDialog'),'Confirm change').props.onClick();assert.equal(view.model.udtDefinitions[0].members[0].dataType,'Int64');
});
check('nested self-cycle is rejected through the drawer as well as drag-and-drop',()=>{
  const type={...blank,members:[{path:'Child',kind:'type',definitionId:'Child',version:1}]},child={id:'Child',version:1,members:[{path:'Value',kind:'memory',dataType:'Double',value:0}]};const view=workspace({types:[type,child]});view.shell().props.onDrop({kind:'type',path:'Press@1'});assert.equal(view.model.udtDefinitions[0].members.length,1);assert.match(view.announcements.at(-1),/cycle/);
  view.shell().props.onMember(0);view.render();const drawer=render(view.panels().drawer,'selection'),editor=component(drawer,'BuilderMemberEditor');editor.props.onChange({...type.members[0],definitionId:'Press'});assert.equal(view.model.udtDefinitions[0].members[0].definitionId,'Child');assert.match(view.announcements.at(-1),/cycle/);
});
check('large folder drop requires a bounded explicit selection',()=>{
  const sources=Array.from({length:140},(_,index)=>({path:`[default]Many/T${index}`,kind:'memory',dataType:'Double'})),view=workspace({sources});view.library().onAdd({kind:'folder',path:'[default]Many'});view.render();const picker=component(view.tree,'FolderSelection');assert.equal(picker.props.limit,128);assert.equal(view.model.udtDefinitions[0].members.length,0);picker.props.onAdd(sources.slice(0,3));assert.equal(view.model.udtDefinitions[0].members.length,3);
});
check('member reordering and draft renaming preserve other types and instances',()=>{
  const type={...blank,members:[{path:'A',kind:'memory',dataType:'Double'},{path:'B',kind:'memory',dataType:'Double'}]},other={id:'Other',version:1,members:[]};const view=workspace({types:[type,other],instances:[{path:'[default]Models/A',definitionId:'Press',version:1}]});view.shell().props.onDrop({kind:'member',path:'1'},0);view.render();assert.deepEqual(view.model.udtDefinitions[0].members.map(member=>member.path),['B','A']);view.shell().props.onChange({...view.model.udtDefinitions[0],id:'Machine'});assert.equal(view.model.instances[0].definitionId,'Machine');assert.equal(view.model.udtDefinitions[1].id,'Other');
});
check('selective upgrades retain parameter values and overrides and leave other rows pinned',()=>{
  const original={...blank,version:1},draft={...blank,version:2},instances=[1,2].map(index=>({path:`[default]Models/P${index}`,definitionId:'Press',version:1,parameters:{Device:`P${index}`},overrides:{Speed:{unit:'rpm'}}}));const view=workspace({types:[draft,original],savedTypes:[original],instances});let grid=view.instances();component(grid,'InstanceRow').props.onSelect(true);grid=view.instances();button(grid,'Update selected to v2').props.onClick();assert.equal(view.model.instances[0].version,2);assert.equal(view.model.instances[1].version,1);assert.deepEqual(view.model.instances[0].overrides,instances[0].overrides);assert.deepEqual(view.model.instances[0].parameters,instances[0].parameters);
});
check('inline parameter cells use the pinned version data type and preserve exact Int64',()=>{
  const original={...blank,parameters:[{name:'Count',type:'Int64'}]},draft={...blank,version:2,parameters:[{name:'Count',type:'Double'}]},view=workspace({types:[draft,original],instances:[{path:'[default]Models/P1',definitionId:'Press',version:1}]});const row=render(component(view.instances(),'InstanceRow'),'row'),parameter=component(row,'InstanceParameter');assert.equal(parameter.props.parameter.type,'Int64');const field=nodes(render(parameter,'parameter')).find(node=>node.type==='input');field.props.onChange({target:{value:'9223372036854775807'}});assert.equal(view.model.instances[0].parameters.Count,'9223372036854775807');
});
check('CSV-only Ask Spark drafts mark corresponding instance rows without marking unrelated rows or types',()=>{
  const instances=[1,2].map(index=>({path:`[default]Models/P${index}`,definitionId:'Press',version:1})),view=workspace({instances,fromAskSpark:[instances[0].path]});
  const rows=nodes(view.instances()).filter(node=>node.type?.name==='InstanceRow');assert.match(content(render(rows[0],'origin-row-1')),/from Ask Spark/);assert.ok(!content(render(rows[1],'origin-row-2')).includes('from Ask Spark'));assert.equal(view.shell().props.fromAskSpark,false);
  const typeOrigin=workspace({instances,fromAskSpark:['Press@1',instances[1].path]});assert.equal(typeOrigin.shell().props.fromAskSpark,true);assert.equal(nodes(typeOrigin.instances()).filter(node=>node.type?.name==='InstanceRow')[1].props.fromAskSpark,true);
});
check('paste dialog validates before updating and adds rows into the same draft type',()=>{
  const type={...blank,parameters:[{name:'Device',type:'String',required:true}]},view=workspace({types:[type]});button(view.instances(),'Paste spreadsheet rows').props.onClick();let dialog=component(view.instances(),'PasteInstances'),body=render(dialog,'paste');nodes(body).find(node=>node.type==='textarea').props.onChange({target:{value:'path\tDevice\n[default]Models/One\tPress01\n[default]Models/Two\tPress02'}});body=render(dialog,'paste');button(body,'Add equipment to draft').props.onClick();assert.equal(view.model.instances.length,2);assert.equal(view.model.instances[1].definitionId,'Press');assert.equal(view.model.instances[1].parameters.Device,'Press02');
});
check('library renders bounded rows for ten thousand tags and keyboard adds selected tags',()=>{
  hooks.clear();const tags=Array.from({length:10000},(_,index)=>({path:`[default]Tag${index}`,dataType:'Double'})),added=[],props={tags,values:[],editable:true,selectedType:'Press@1',usedTargets:new Set(),onAdd:item=>added.push(item),onFolderInstance:()=>{}};hooks.begin('library');const tree=Library(props),rows=nodes(tree).filter(node=>node.props.role==='treeitem');assert.equal(rows.length,20);rows[0].props.onKeyDown({key:'Enter',ctrlKey:false,preventDefault(){}});assert.equal(added.length,1);assert.equal(added[0].kind,'tag');
});
check('reference drawer excludes acquisition-only settings and keeps target data type read-only',()=>{
  hooks.clear();hooks.begin('member');const tree=BuilderMemberEditor({value:{path:'Speed',kind:'reference',dataType:'Double',target:definitions[0].path},definition:blank,model:emptyModelPackage(),connections:[],tags:definitions,readOnly:false,onChange(){},onRemove(){}});assert.ok(!content(tree).includes('Scan group'));assert.ok(!content(tree).includes('Interval'));assert.ok(nodes(tree).some(node=>node.type==='input'&&node.props.readOnly&&node.props.value==='Double'));
});
check('Build delegates changes without preview/apply actions or gateway calls',()=>{
  const view=workspace();const tree=render(view.shell(),'shell');assert.ok(!content(tree).includes('Apply'));assert.ok(!content(tree).includes('Preview'));assert.equal(view.model.version,3);
});

check('equipment name editing preserves its organized parent path',()=>{
  const view=workspace({instances:[{path:'[default]Plant/Line1/Press01',definitionId:'Press',version:1}]}),row=render(component(view.instances(),'InstanceRow'),'equipment-name');
  const field=nodes(row).find(node=>node.type==='input'&&node.props['aria-label']==='Equipment name 1');assert.equal(field.props.value,'Press01');assert.equal(field.props.title,'[default]Plant/Line1/Press01');field.props.onChange({target:{value:'Press02'}});assert.equal(view.model.instances[0].path,'[default]Plant/Line1/Press02');
});
check('new users get a reusable model draft and an actionable equipment empty state',()=>{
  const view=workspace({types:[]});button(render(view.shell(),'empty-shell'),'Use my dataChoose your own tags or begin with manual values.').props.onClick();view.render();assert.equal(view.selectedType,'NewModel@1');assert.equal(view.model.udtDefinitions.at(-1).members.length,0);assert.equal(view.panels().showLibrary,true);
  const grid=view.instances();assert.ok(content(grid).includes('One model, many machines'));assert.equal(nodes(grid).filter(node=>node.type==='table').length,0);button(grid,'＋ Add equipment').props.onClick();assert.equal(view.model.instances[0].definitionId,'NewModel');
});
check('data library starts a model from keyboard selection but protects saved models',()=>{
  const added=[],props={tags:definitions,values:[],editable:true,selectedType:'',usedTargets:new Set(),onAdd:item=>added.push(item),onFolderInstance(){}};
  hooks.clear();hooks.begin('no-draft-library');let tree=Library(props);const search=nodes(tree).find(node=>node.type==='input');search.props.onChange({target:{value:'Speed'}});hooks.begin('no-draft-library');tree=Library(props);const row=nodes(tree).find(node=>node.props.role==='treeitem');row.props.onKeyDown({key:'Enter',ctrlKey:false,preventDefault(){}});assert.equal(added.length,1);assert.equal(added[0].kind,'tag');
  hooks.begin('saved-library');tree=Library({...props,selectedType:'Press@1',editable:false});assert.equal(button(tree,'Add to model').props.disabled,true);
});
check('advanced direct source and per-equipment overrides remain available behind disclosure',()=>{
  const view=workspace({instances:[{path:'[default]Models/Press01',definitionId:'Press',version:1}]}),shell=render(view.shell(),'disclosure-shell');
  const advanced=nodes(shell).find(node=>node.type==='details'&&content(node).includes('Advanced: connect a field directly'));assert.ok(advanced);assert.ok(!advanced.props.open);button(advanced,'＋ OPC UA field').props.onClick();assert.equal(view.model.udtDefinitions[0].members[0].kind,'opcua');
  view.render();view.panels().instances.props.onEdit(0);view.render();const drawer=render(view.panels().drawer,'equipment-drawer'),overrides=nodes(drawer).find(node=>node.type==='details'&&content(node).includes('Advanced: customize fields'));assert.ok(overrides);assert.ok(component(overrides,'ModelOverrides'));
});

check('a folder dropped on an empty workspace creates one draft and preserves parameterization',()=>{
  const view=workspace({types:[]});view.shell().props.onDrop({kind:'folder',path:'[default]Equipment/Press01'});view.render();assert.equal(view.model.udtDefinitions.length,1);assert.equal(view.model.udtDefinitions[0].members.length,2);assert.equal(view.selectedType,'NewModel@1');component(view.tree,'ParameterizeDialog').props.onAccept('Machine');assert.equal(view.model.instances.length,1);assert.equal(view.model.instances[0].parameters.Machine,'Press01');
});
check('empty-shell large folder drops request a bounded field selection',()=>{
  const sources=Array.from({length:140},(_,index)=>({path:'[default]Many/T'+index,kind:'memory',dataType:'Double'})),view=workspace({types:[],sources});view.shell().props.onDrop({kind:'folder',path:'[default]Many'});view.render();const picker=component(view.tree,'FolderSelection');assert.equal(view.model.udtDefinitions[0].members.length,0);assert.equal(picker.props.limit,128);picker.props.onAdd(sources.slice(0,2));assert.equal(view.model.udtDefinitions[0].members.length,2);
});
check('add-a-model-inside picker bounds results, searches every model and the version select stays on the chosen model',()=>{
  hooks.clear();const types=Array.from({length:250},(_,index)=>({id:'Machine'+String(index).padStart(3,'0'),version:1,members:[]}));types.push({...types[0],version:2});let selected='Machine000@2';const added=[];const props={types,savedTypes:[],selected,libraryOpen:false,onToggleLibrary(){},onSelect:key=>{selected=key;},onAdd:drag=>added.push(drag)};hooks.begin('picker');let picker=Toolbar(props);const version=nodes(picker).find(node=>node.type==='select');assert.equal(nodes(version).filter(node=>node.type==='option').length,2);const results=nodes(picker).find(node=>node.props.className==='model-picker-results');assert.equal(React.Children.count(results.props.children),100);assert.ok(!content(results).includes('Machine000'));nodes(picker).find(node=>node.type==='input').props.onChange({target:{value:'Machine249'}});hooks.begin('picker');picker=Toolbar(props);button(picker,'Machine249v1 · draft').props.onClick();assert.deepEqual(added,[{kind:'type',path:'Machine249@1'}]);version.props.onChange({target:{value:'Machine000@1'}});assert.equal(selected,'Machine000@1');hooks.begin('picker');assert.equal(Toolbar({...props,selected:''}),null);
});
check('empty workspace offers a starter or own data before opening the builder',()=>{
  const view=workspace({types:[]}),shell=render(view.shell(),'empty-shell');assert.ok(!nodes(view.tree).some(node=>node.type?.name==='ModelBuilderPanels'));assert.ok(content(shell).includes('How would you like to start?'));button(shell,'Use a starterExplore Motor, Pump, Press or OEE with example values.').props.onClick();assert.deepEqual(view.actions,['starter']);assert.equal(view.model.udtDefinitions.length,0);button(shell,'Use my dataChoose your own tags or begin with manual values.').props.onClick();view.render();assert.equal(view.model.udtDefinitions.length,1);assert.equal(view.selectedType,'NewModel@1');assert.equal(view.panels().showLibrary,true);assert.ok(!content(render({type:Library,props:view.library()},'data-only-library')).includes('Your models'));
});
check('the setup guide is gone and the data library opens on request and remembers the choice',()=>{
  const view=workspace();assert.ok(!nodes(view.tree).some(node=>node.type?.name==='ModelBuilderGuide'));assert.equal(view.panels().showLibrary,false);let toolbar=view.toolbar();assert.equal(button(toolbar,'＋ Add fields from data').props['aria-pressed'],false);button(toolbar,'＋ Add fields from data').props.onClick();view.render();assert.equal(view.panels().showLibrary,true);assert.equal(storage.get('sparkstudio.model-builder-library-open'),'true');toolbar=view.toolbar();button(toolbar,'Hide data library').props.onClick();view.render();assert.equal(view.panels().showLibrary,false);assert.equal(storage.get('sparkstudio.model-builder-library-open'),'false');
});
check('fields and machines share one page so the machines pane is never hidden',()=>{
  const view=workspace({instances:[{path:'[default]Models/Press01',definitionId:'Press',version:1}]}),panels=render(component(view.tree,'ModelBuilderPanels'),'one-page');assert.equal(nodes(panels).find(node=>node.props.className==='model-builder-pane model-instances-pane').props.hidden,undefined);assert.ok(!nodes(panels).some(node=>node.type==='button'&&/Define fields|Connect machines|Combined view/.test(content(node))));
});
check('closing the data library keeps its search and selection mounted',()=>{
  const view=workspace();button(view.toolbar(),'＋ Add fields from data').props.onClick();view.render();let library=render({type:Library,props:view.library()},'retained-library');nodes(library).find(node=>node.type==='input').props.onChange({target:{value:'Speed'}});library=render({type:Library,props:view.library()},'retained-library');const row=nodes(library).find(node=>node.props.role==='treeitem');row.props.onClick();let panels=render(component(view.tree,'ModelBuilderPanels'),'responsive-panels');assert.equal(nodes(panels).find(node=>node.type==='button'&&node.props['aria-label']==='Close data library').props.onClick,view.panels().onCloseLibrary);view.panels().onCloseLibrary();view.render();panels=render(component(view.tree,'ModelBuilderPanels'),'responsive-panels');assert.equal(nodes(panels).find(node=>node.props.className==='model-builder-pane model-library-pane').props.hidden,true);assert.ok(component(panels,'ModelBuilderLibrary'));button(view.toolbar(),'＋ Add fields from data').props.onClick();view.render();library=render({type:Library,props:view.library()},'retained-library');assert.equal(nodes(library).find(node=>node.type==='input').props.value,'Speed');assert.equal(nodes(library).find(node=>node.props.role==='treeitem').props['aria-selected'],true);assert.equal(view.selectedType,'Press@1');
});
check('busy preview prevents dragging and disables topbar actions',()=>{
  const view=workspace({disabled:true});view.library().onAdd({kind:'tag',path:definitions[0].path});view.shell().props.onDrop({kind:'folder',path:'[default]Equipment/Press01'});assert.equal(view.model.udtDefinitions[0].members.length,0);const toolbar=view.toolbar();assert.equal(button(toolbar,'＋ Add fields from data').props.disabled,true);assert.equal(nodes(toolbar).find(node=>node.type==='select').props.disabled,true);const library=render({type:Library,props:view.library()},'busy-library');assert.equal(nodes(library).find(node=>node.props.role==='treeitem').props.draggable,false);
});

console.log(`${passed} Model builder UI checks passed.`);
