import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const code = ts.transpileModule(fs.readFileSync(new URL('src/tableEditing.ts', import.meta.url), 'utf8'), {compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const {validateTableEditDefinition:validate,parseTableEditValue:parse,tableEditRowIdentity:identity}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
const config=()=>({versionColumn:'version',columns:[{key:'name',type:'string',required:true,maxLength:20},{key:'quantity',type:'number',integer:true,min:0,max:100},{key:'enabled',type:'boolean'}],script:'result = inputs'});
let passed=0;
function test(name,run){run();passed++;console.log('PASS '+name);}
test('editing is opt-in and runtime permits omitted code only',()=>{
  assert.equal(validate(undefined,undefined),null);assert.equal(validate(config(),'id'),null);
  const runtime=config();delete runtime.script;
  assert.ok(validate(runtime,'id'));assert.equal(validate(runtime,'id',true),null);
  for(const script of [null,'',' ',12,'x'.repeat(64001)])assert.ok(validate({...runtime,script},'id',true));
  assert.equal(validate({...runtime,script:'x'.repeat(64000)},'id'),null);
});
test('definitions reject malformed shapes and unsafe identity metadata',()=>{
  for(const value of [null,[],false,{}, {...config(),other:true},{...config(),columns:[]},{...config(),columns:null},{...config(),versionColumn:'id'},{...config(),versionColumn:'version '},{...config(),versionColumn:'v\n'}, {...config(),columns:Array.from({length:65},(_,i)=>({key:'c'+i,type:'string'}))}])assert.ok(validate(value,'id'),JSON.stringify(value));
  for(const value of [undefined,null,'',' ',' id','id\n',1,'x'.repeat(129)])assert.ok(validate(config(),value));
  assert.equal(validate({...config(),columns:Array.from({length:64},(_,i)=>({key:'c'+i,type:'string'}))},'id'),null);
});
test('column metadata is typed and constraints belong to their declared type',()=>{
  const invalid=[null,{}, {key:'name',type:'object'},{key:'id',type:'string'},{key:'version',type:'number'},{key:'name',type:'string',other:1}, {key:'name',type:'number',required:true},{key:'name',type:'boolean',maxLength:1}, {key:'name',type:'string',min:0},{key:'name',type:'boolean',integer:false},{key:'name',type:'number',min:2,max:1}];
  for(const [field,values] of Object.entries({required:[null,1,'true'],maxLength:[null,0,4097,1.5,'20']}))for(const value of values)invalid.push({key:'name',type:'string',[field]:value});
  for(const [field,values] of Object.entries({min:[null,Infinity,Number.MAX_SAFE_INTEGER+1,'0'],max:[null,-Infinity,-Number.MAX_SAFE_INTEGER-1],integer:[null,0,'true']}))for(const value of values)invalid.push({key:'name',type:'number',[field]:value});
  for(const column of invalid)assert.ok(validate({...config(),columns:[column]},'id'),JSON.stringify(column));
  assert.ok(validate({...config(),columns:[{key:'name',type:'string'},{key:'name',type:'string'}]},'id'));
});
test('text editing preserves whitespace and enforces explicit required and size constraints',()=>{
  assert.deepEqual(parse('  value  ',{key:'n',type:'string'}),{value:'  value  '});
  assert.deepEqual(parse('',{key:'n',type:'string'}),{value:''});
  assert.ok(parse('  ',{key:'n',type:'string',required:true}).error);
  assert.ok(parse('a'.repeat(4097),{key:'n',type:'string'}).error);
  assert.ok(parse('abc',{key:'n',type:'string',maxLength:2}).error);
  assert.ok(parse(false,{key:'n',type:'string'}).error);
});
test('numeric edits require explicit finite decimal text and preserve zero',()=>{
  const field={key:'q',type:'number'};
  for(const value of ['', ' ', '0x10','Infinity','NaN','3px','1,000',String(Number.MAX_SAFE_INTEGER+1),'1e309'])assert.ok(parse(value,field).error,value);
  for(const [text,value] of [['0',0],[' 2.5 ',2.5],['-1e2',-100],['.25',.25]])assert.deepEqual(parse(text,field),{value});
  assert.ok(parse('2.5',{...field,integer:true}).error);assert.ok(parse('-1',{...field,min:0}).error);assert.ok(parse('101',{...field,max:100}).error);
  assert.deepEqual(parse('100',{...field,max:100}),{value:100});assert.ok(parse(false,field).error);
});
test('boolean edits do not coerce strings or numbers',()=>{
  assert.deepEqual(parse(false,{key:'e',type:'boolean'}),{value:false});assert.deepEqual(parse(true,{key:'e',type:'boolean'}),{value:true});
  for(const value of ['false','true','0',''])assert.ok(parse(value,{key:'e',type:'boolean'}).error);
});
test('row identity requires complete safe unique keys and versions',()=>{
  const rows=[{id:1,version:0},{id:'1',version:2}];
  assert.deepEqual(identity(rows,rows[0],'id','version'),{key:1,version:0});
  assert.deepEqual(identity(rows,rows[1],'id','version'),{key:'1',version:2});
  assert.ok(identity(rows,{id:1,version:0},'id','version').error);
  for(const bad of [{id:1,version:1},{id:'',version:1},{id:' '.repeat(3),version:1},{id:'a'.repeat(4097),version:1},{id:Number.MAX_SAFE_INTEGER+1,version:1},{id:'x',version:-1},{id:'x',version:1.1},{id:'x',version:'1'},{id:'x',version:null},{id:'x'}])assert.ok(identity([rows[0],bad],rows[0],'id','version').error,JSON.stringify(bad));
  assert.ok(identity(rows,rows[0],'id','id').error);
});
console.log(`${passed} table-editing model checks passed.`);
