import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { createTestModuleFiles } from './test-module-files.mjs';
const file = createTestModuleFiles(), modules = new Map();
function load(name) {
  if (modules.has(name)) return modules.get(name);
  if (name.endsWith('.json')) { const result = file(`export default ${fs.readFileSync(new URL(`src/${name}`, import.meta.url), 'utf8')};`); modules.set(name, result); return result; }
  const source = fs.readFileSync(new URL(`src/${name}.ts`, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
    .replace(/from "\.\/([^"\n]+)"/g, (_match, dependency) => `from ${JSON.stringify(load(dependency))}`);
  const url = file(code); modules.set(name, url); return url;
}
const { createModelFaceplate, collectModelDiagnostics } = await import(load('designerModel'));
const { coerceTemplateParameter, validateTemplateParameterTypes, resolveTemplateParameters, projectInputContext } = await import(load('templateModel'));
const { matchesModelRequirement, modelLeaves, getModelInstances, getModelTypes } = await import(load('modelApi'));
const { apiUrl } = await import(load('api'));
const path = '[default]Acme/Line/CNC01';
const leaf = (name, unit='') => ({ path:`${path}/${name}`,modelPath:name,kind:'reference',dataType:'Double',metadata:{unit},quality:'Good',value:7200 });
const object = {path,definitionId:'CNC',version:1,parameters:{Device:'Haas01'},restrictedMembers:0,members:{Execution:leaf('Execution'),Spindle:{Speed:leaf('Spindle/Speed','rev/min'),Load:leaf('Spindle/Load','%')}}};
const spindle = {id:'Spindle',version:1,members:[{path:'Speed',kind:'reference',dataType:'Double'},{path:'Load',kind:'reference',dataType:'Double'}]};
const cnc = {id:'CNC',version:1,members:[{path:'Execution',kind:'reference',dataType:'String'},{path:'Spindle',kind:'type',definitionId:'Spindle',version:1}]};
let serial=0,passed=0;const check=(name,fn)=>{fn();passed++;console.log(`PASS ${name}`);};
const template = createModelFaceplate(object, kind=>`${kind}-${++serial}`);
const project={id:'model-test',name:'Model',revision:1,parameters:{},templates:[template],screens:[{id:'main',name:'Main',width:800,height:600,components:[]}]};
check('faceplate creates one ordinary indirect value per leaf, with units and portable requirements',()=>{
  assert.equal(template.components.length,3);assert.deepEqual(template.parameterTypes,{machine:'model'});assert.deepEqual(template.modelParameters,{machine:{definitionId:'CNC'}});
  assert.deepEqual(template.components.map(c=>c.props.tagPath),['{machine}/Execution','{machine}/Spindle/Speed','{machine}/Spindle/Load']);
  assert.equal(template.components[1].props.unit,'rev/min');assert.ok(template.components.every(c=>c.type==='value'));assert.equal(new Set(template.components.map(c=>c.id)).size,3);
  assert.equal(modelLeaves(object.members).length,3);assert.equal(object.members.Spindle.Speed.value,7200);
});
check('partial scope cannot generate a silently incomplete faceplate',()=>assert.throws(()=>createModelFaceplate({...object,restrictedMembers:1}),/every model member/));
check('long model units remain visible without exceeding the value widget unit limit',()=>{
  const unit='standardized workshop measurement units per cycle';
  const generated=createModelFaceplate({...object,members:{Speed:leaf('Speed',unit)}},kind=>`${kind}-${++serial}`);
  assert.equal(generated.components[0].props.unit,'');assert.ok(generated.components[0].props.text.includes(unit));
});
check('model parameters preserve concrete paths and reject scalar or recursive addresses',()=>{
  assert.equal(coerceTemplateParameter('machine',path,'model'),path);
  for(const value of [42,true,'','[default]A//B','[default]A/../B','[default]A/{nested}','[other]A','[default]A\\B'])assert.throws(()=>coerceTemplateParameter('machine',value,'model'));
  assert.equal(resolveTemplateParameters({...template,parameters:{machine:'{asset}'}},{asset:path}).parameters.machine,path);
});
check('portable requirements validate syntax without needing gateway types',()=>{
  validateTemplateParameterTypes(template);
  for(const requirement of [undefined,{definitionId:''},{definitionId:'CNC',minVersion:0},{definitionId:'CNC',maxVersion:1000001},{definitionId:'CNC',minVersion:2,maxVersion:1},{definitionId:'CNC',unknown:true}])
    assert.throws(()=>validateTemplateParameterTypes({...template,modelParameters:{machine:requirement}}));
  assert.throws(()=>validateTemplateParameterTypes({...template,parameterTypes:{machine:'string'}}));
});
check('missing gateway types are actionable diagnostics rather than failed import validation',()=>{
  const rows=collectModelDiagnostics(project,[],[]);assert.equal(rows.length,1);assert.match(rows[0].message,/Unresolved model requirement/);assert.equal(rows[0].target.id,template.id);
});
check('unchanged composed model has no diagnostics and no input mutation',()=>{
  const before=JSON.stringify(project);assert.deepEqual(collectModelDiagnostics(project,[cnc,spindle],[object]),[]);assert.equal(JSON.stringify(project),before);
});
check('explicit upgrade removing a nested leaf diagnoses the preserved faceplate binding',()=>{
  const v2={...cnc,version:2,members:[cnc.members[0],{...cnc.members[1],version:2}]},spindle2={...spindle,version:2,members:[spindle.members[0]]};
  const rows=collectModelDiagnostics(project,[cnc,spindle,v2,spindle2],[{...object,version:2}]);assert.equal(rows.length,1);assert.match(rows[0].message,/Spindle\/Load.*CNC v2/);assert.equal(template.components.length,3);
});
check('version mismatch in a placement override is diagnosed even if the template default remains valid',()=>{
  const required={...template,modelParameters:{machine:{definitionId:'CNC',maxVersion:1}}},second={...object,path:'[default]Acme/Line/CNC02',version:2};
  const changed={...project,templates:[required],screens:[{...project.screens[0],components:[{id:'placement',type:'template',props:{templateId:template.id,parameters:{machine:second.path}}}]}]};
  const rows=collectModelDiagnostics(changed,[cnc,spindle],[object,second]);assert.equal(rows.length,1);assert.equal(rows[0].target.componentId,'placement');assert.match(rows[0].message,/version range/);
});
check('type and inclusive version range matching never admits other types',()=>{
  assert.ok(matchesModelRequirement(object,{definitionId:'CNC',minVersion:1,maxVersion:1}));assert.equal(matchesModelRequirement(object,{definitionId:'CNC',minVersion:2}),false);assert.equal(matchesModelRequirement(object,{definitionId:'Pump'}),false);
});
check('requirement edits invalidate form context while project model reads use scoped routes',()=>{
  assert.notEqual(projectInputContext(project),projectInputContext({...project,templates:[{...template,modelParameters:{machine:{definitionId:'CNC',maxVersion:1}}}]}));
  assert.equal(apiUrl('/model/instances','demo'),'/api/projects/demo/model/instances');
});
const {configureAuthSession}=await import(load('authSession'));configureAuthSession({audience:'engineering',projectId:null,csrfToken:null,key:'fixture'});
let pages=0;globalThis.fetch=async()=>new Response(JSON.stringify({generation:7,items:pages++===0?[object]:[{...object,path:'[default]Other',version:2}],offset:pages===1?0:1,limit:1,total:2}),{status:200});
assert.deepEqual((await getModelInstances({definitionId:'CNC',maxVersion:1})).map(item=>item.path),[path]);passed++;console.log('PASS matching instance picker consumes all scoped pages and applies version limits');
pages=0;globalThis.fetch=async()=>new Response(JSON.stringify({generation:pages++,items:[cnc],offset:0,limit:1,total:2}),{status:200});
await assert.rejects(getModelTypes(),/model changed while loading/);passed++;console.log('PASS configuration generation changes cannot produce mixed model pages');
console.log(`${passed}/${passed} Designer model checks passed.`);
