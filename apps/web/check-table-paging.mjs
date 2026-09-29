import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const load = async name => {
 const source=fs.readFileSync(new URL('./src/'+name+'.ts',import.meta.url),'utf8');
 const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
 return import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
};
const {tablePage}=await load('tableModel');
const {resolveTableSelection}=await load('tableSelection');
let passed=0;
const test=(name,run)=>{run();passed++;console.log('PASS '+name)};
const rows=Array.from({length:57},(_,i)=>({id:i+1,name:'Record '+(i+1),quantity:57-i,enabled:i%2===0}));
const data={columns:['id','name','quantity','enabled'],rows};
test('first, middle and final pages contain distinct bounded subsets',()=>{
 const a=tablePage(data,'',null,0,25),b=tablePage(data,'',null,1,25),c=tablePage(data,'',null,2,25);
 assert.equal(a.pages,3);assert.deepEqual([a.start,a.end,b.start,b.end,c.start,c.end],[1,25,26,50,51,57]);
 assert.deepEqual([...a.rows,...b.rows,...c.rows],rows);assert.equal(c.rows.length,7);
});
test('filter then global numeric sort precede slicing',()=>{
 const expected=rows.filter(r=>r.enabled).sort((a,b)=>a.quantity-b.quantity);
 const page=tablePage(data,'true',{column:'quantity',descending:false},1,10);
 assert.deepEqual(page.rows,expected.slice(10,20));assert.equal(page.filtered,29);assert.equal(page.total,57);
 assert.deepEqual(rows.map(r=>r.id),Array.from({length:57},(_,i)=>i+1));
});
test('sorting strings uses natural order and sort ties retain source order',()=>{
 const source={columns:['label'],rows:[{id:1,label:'Part 20'},{id:2,label:'Part 3'},{id:3,label:'Part 3'}]};
 assert.deepEqual(tablePage(source,'',{column:'label',descending:false},0,25).rows.map(r=>r.id),[2,3,1]);
 assert.deepEqual(tablePage(source,'',{column:'label',descending:true},0,25).rows.map(r=>r.id),[1,2,3]);
});
test('zero, false and null cells remain searchable without changing values',()=>{
 const source={columns:['v'],rows:[{v:0},{v:false},{v:null}]};
 assert.deepEqual(tablePage(source,'false',null,0,25).rows,[{v:false}]);
 assert.deepEqual(tablePage(source,'0',null,0,25).rows,[{v:0}]);
});
test('empty and no-match sets have zero row ranges and one disabled page',()=>{
 for(const source of [null,{columns:[],rows:[]},data]){
 const result=tablePage(source,'not-found',null,500,25);
 assert.deepEqual([result.page,result.pages,result.start,result.end,result.filtered],[0,1,0,0,0]);
 }
});
test('page clamps when rows shrink, including negative and nonfinite requests',()=>{
 assert.equal(tablePage(data,'',null,99,25).page,2);
 for(const index of [-100,NaN,Infinity])assert.equal(tablePage(data,'',null,index,25).page,0);
 assert.equal(tablePage({columns:data.columns,rows:rows.slice(0,3)},'',null,2,25).page,0);
});
test('page-size limits reject coercion and malformed definitions',()=>{
 for(const size of [0,-1,101,1.5,'25',null,NaN,Infinity])assert.throws(()=>tablePage(data,'',null,0,size),/whole number/);
 assert.equal(tablePage(data,'',null,0,1).rows.length,1);assert.equal(tablePage(data,'',null,0,100).rows.length,57);
});
test('second-page selection retains original identity and full-result validation',()=>{
 const page=tablePage(data,'',null,1,25);const row=page.rows[0];
 const result=resolveTableSelection(rows,row,'id',{quantity:'quantity'});
 assert.equal(result.ok,true);assert.equal(result.key,26);assert.deepEqual(result.changes,[['quantity',32]]);
 const duplicate=[...rows,{...rows[0]}];assert.equal(resolveTableSelection(duplicate,row,'id',{}).ok,false);
});
test('typed target failure returns no partial field changes',()=>{
 const row={id:'A',name:'New name',quantity:-1};const visited=[];
 const result=resolveTableSelection([row],row,'id',{name:'name',quantity:'quantity'},(field,value)=>{visited.push(field);return field==='quantity'&&value<0?'Quantity must be positive':null;});
 assert.equal(result.ok,false);assert.deepEqual(result.changes,[]);assert.deepEqual(visited,['name','quantity']);
});
console.log(`${passed} table paging/selection checks passed.`);
