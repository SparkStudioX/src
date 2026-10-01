import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

// Render the shipped chart model and SVG/presentation together. Only the external
// dataset subscription and application owner are replaced; no requests are made.
const require = createRequire(import.meta.url), modules = new Map();
const asModule = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
const react = pathToFileURL(require.resolve('react')).href;
const hooks = asModule(`export * from ${JSON.stringify(react)}; export const useState=initial=>[globalThis.__chartRange??initial,value=>{globalThis.__chartRange=value;}];`);
modules.set('applicationState', asModule('export const useApplicationStateContext=()=>globalThis.__chartOwner;'));
modules.set('useDatasetBinding', asModule('export const useDatasetBinding=(...args)=>{globalThis.__chartDatasetArgs=args;return globalThis.__chartSample??{status:"idle"};};'));
function moduleUrl(name) {
  if (name.endsWith('.json')) return 'data:text/javascript;base64,' + Buffer.from('export default ' + fs.readFileSync(new URL('src/' + name, import.meta.url), 'utf8')).toString('base64');
  if (modules.has(name)) return modules.get(name);
  const file = ['tsx','ts'].map(extension=>new URL(`src/${name}.${extension}`,import.meta.url)).find(file=>fs.existsSync(file)); assert.ok(file,name);
  const code = ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText
    .replace(/import "\.\/[^"\n]+\.css";\r?\n/g,'')
    .replace(/(from\s+|import\s+)(["'])([^"']+)\2/g,(_match,prefix,_quote,dependency)=>`${prefix}${JSON.stringify(dependency==='react'?hooks:dependency.startsWith('./')?moduleUrl(dependency.slice(2)):pathToFileURL(require.resolve(dependency)).href)}`);
  const url=asModule(code); modules.set(name,url); return url;
}
const {ChartGraphic,ChartPresentation,default:ChartComponent}=await import(moduleUrl('ChartComponent'));
const {buildChart,chartKinds,chartColors}=await import(moduleUrl('chartModel'));
const base={kind:'line',xKey:'x',series:[{key:'value',label:'Measured',color:'#123456'}]};
const dataset=rows=>({columns:['x','value'],rows:rows.map(([x,value])=>({x,value}))});
const component=(config=base,type='chart')=>({id:'chart',type,x:0,y:0,width:640,height:350,props:{text:'Authored chart',chart:config}});
const render=(Component,props)=>renderToStaticMarkup(React.createElement(Component,props));
const presentation=(config,data,options={})=>render(ChartPresentation,{component:component(config),data,...options});
const graphic=(config,data,compact=false)=>render(ChartGraphic,{config,model:buildChart(config,data),compact});
const descendants=(node,predicate)=>!node||typeof node!=='object'?[]:[...(predicate(node)?[node]:[]),...React.Children.toArray(node.props?.children).flatMap(child=>descendants(child,predicate))];
let passed=0; function check(name,run){delete globalThis.__chartRange;run();passed++;console.log(`PASS ${name}`);}
function fixture(kind) {
  if(kind==='box')return {config:{...base,kind,series:['low','q1','median','q3','high'].map(key=>({key}))},data:{columns:['x','low','q1','median','q3','high'],rows:[{x:'Batch A',low:0,q1:1,median:2,q3:3,high:4}]}};
  if(kind==='gantt')return {config:{...base,kind,endKey:'end'},data:{columns:['x','value','end'],rows:[{x:0,value:1,end:1000},{x:1500,value:1,end:1500}]}};
  return {config:{...base,kind},data:dataset((['scatter','timeSeries'].includes(kind)?[0,1000,2000]:['Alpha','Beta','Gamma']).map((x,index)=>[x,[1,4,2][index]]))};
}
check('all ten chart kinds render finite accessible SVG through presentation',()=>{
  assert.equal(chartKinds.length,10);
  for(const kind of chartKinds){const {config,data}=fixture(kind),html=presentation(config,data);assert.match(html,new RegExp(`aria-label="${kind} chart`));assert.match(html,/role="img"/);assert.doesNotMatch(html,/NaN|Infinity|undefined/);assert.match(html,/View data/);}
});
check('sparkline renders compact geometry without axes, legend or data table',()=>{
  const html=render(ChartPresentation,{component:component(base,'sparkline'),data:dataset([['A',2],['B',3]])});
  assert.match(html,/chart-compact/);assert.match(html,/<svg/);assert.doesNotMatch(html,/<text|chart-legend|View data|chart-range/);
});
check('empty, loading, unconfigured and query failure states have diagnostics and no plotted fallback',()=>{
  for(const [props,expected]of [[{data:dataset([])},'No observations in this range.'],[{status:'loading'},'Loading chart data'],[{error:'Published query is unavailable.'},'Published query is unavailable.'],[{},'Choose a chart dataset.']]){const html=render(ChartPresentation,{component:component(),...props});assert.ok(html.includes(expected));assert.doesNotMatch(html,/<svg/);}
  assert.match(render(ChartPresentation,{component:{...component(),props:{}},data:dataset([['A',1]])}),/Configure chart axes and series/);
});
check('line and area paths preserve null and bad-quality gaps without bridges',()=>{
  const data={columns:['x','value','quality'],rows:[{x:'A',value:1,quality:'Good'},{x:'B',value:null,quality:'Good'},{x:'C',value:8,quality:'Bad_Disconnected'},{x:'D',value:4,quality:'Good_Local'}]};
  for(const kind of ['line','area']){const html=presentation({...base,kind,qualityKey:'quality'},data);assert.match(html,/2 missing or bad-quality values; gaps are preserved/);assert.equal((html.match(/fill="none" stroke="#123456"/g)||[]).length,2);assert.equal((html.match(/<circle/g)||[]).length,2);}
});
check('bars include negative and zero observations with positive rectangle dimensions',()=>{
  const html=graphic({...base,kind:'bar'},dataset([['Negative',-5],['Zero',0],['Positive',6]]));
  const bars=[...html.matchAll(/<rect[^>]+fill="#123456"/g)].map(match=>match[0]);assert.equal(bars.length,3);
  for(const bar of bars){assert.ok(Number(bar.match(/width="([^"]+)"/)[1])>0);assert.ok(Number(bar.match(/height="([^"]+)"/)[1])>=1);}
  assert.match(html,/Negative, Measured: -5/);
});
check('scatter orders observations by numeric X without mutating the supplied dataset',()=>{
  const data=dataset([[9,1],[1,3],[5,2]]),before=JSON.stringify(data),html=graphic({...base,kind:'scatter'},data);
  const positions=[...html.matchAll(/<circle[^>]*cx="([^"]+)"/g)].map(match=>Number(match[1]));assert.equal(positions.length,3);assert.ok(positions[0]<positions[1]&&positions[1]<positions[2]);assert.equal(JSON.stringify(data),before);
});
check('pie legends identify category colors and a full slice is a circle',()=>{
  const html=presentation({...base,kind:'pie'},dataset([['Only category',7],['Zero category',0],['Missing category',null]]));
  assert.equal((html.match(/<circle/g)||[]).length,1);assert.match(html,/Only category: 7 \(100%\)/);
  const legend=html.match(/<ul class="chart-legend">([^]*?)<\/ul>/)?.[1]??'';assert.ok(legend.includes('Only category'));assert.ok(legend.includes(chartColors[0]));assert.doesNotMatch(legend,/Measured|Zero category|Missing category/);
  assert.match(presentation({...base,kind:'pie'},dataset([['A',0]])),/No positive values to display/);
});
check('radar refuses too few categories and never closes a polygon across missing data',()=>{
  assert.match(presentation({...base,kind:'radar'},dataset([['A',1],['B',2]])),/at least three categories/);
  const html=presentation({...base,kind:'radar'},dataset([['A',1],['B',null],['C',2]]));assert.equal((html.match(/<polygon/g)||[]).length,4);assert.doesNotMatch(html,/fill-opacity="0.15"/);assert.match(html,/1 missing or bad-quality/);
});
check('box plots show ordered summaries and incomplete boxes stay absent',()=>{
  const {config,data}=fixture('box');assert.match(graphic(config,data),/Batch A: 0, 1, 2, 3, 4/);
  data.rows[0].median=null;const html=presentation(config,data);assert.doesNotMatch(html,/fill-opacity="0.25"/);assert.match(html,/1 missing or bad-quality/);
});
check('Gantt accepts epoch zero and zero-duration tasks while bad-quality tasks stay absent',()=>{
  const {config,data}=fixture('gantt');let html=graphic(config,data);assert.match(html,/1970-01-01T00:00:01.000Z/);assert.match(html,/width="1"/);
  config.qualityKey='quality';data.columns.push('quality');data.rows[0].quality='Bad';data.rows[1].quality='Good';html=graphic(config,data);assert.equal((html.match(/fill="#123456"/g)||[]).length,1);
});
check('status paths use horizontal-then-vertical steps',()=>{
  const html=graphic({...base,kind:'status'},dataset([['A',0],['B',1],['C',0]]));assert.match(html,/d="M[^"H]+H[^"V]+ V[^"H]+H[^"V]+ V/);
});
check('range controls select displayed observations and exclude off-range gap counts',()=>{
  const config={...base,rangeSelector:true},data=dataset([['A',null],['B',1],['C',2],['D',3]]);
  globalThis.__chartRange=[25,100];const html=presentation(config,data);assert.match(html,/3 observations/);assert.doesNotMatch(html,/missing or bad-quality/);
  const tree=ChartPresentation({component:component(config),data}),inputs=descendants(tree,node=>node.type==='input');assert.equal(inputs.length,2);inputs[0].props.onChange({target:{value:'50'}});assert.deepEqual(globalThis.__chartRange,[50,100]);
});
check('invalid axes and category shapes produce diagnostics without invalid SVG coordinates',()=>{
  for(const [config,data]of [[{...base,yMin:0,yMax:Number.MIN_VALUE},dataset([['A',1]])],[base,dataset([[undefined,1]])],[base,dataset([[NaN,1]])],[{...base,kind:'timeSeries'},dataset([[9e15,1]])]]){const model=buildChart(config,data);assert.ok(model.error);const html=presentation(config,data);assert.match(html,/chart-diagnostic/);assert.doesNotMatch(html,/<svg/);}
});
check('captions and table cells are escaped, legends can be hidden, refresh state remains visible',()=>{
  const html=presentation({...base,showLegend:false},dataset([['<script>alert(1)</script>',1]]),{refreshing:true});assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>|chart-legend/);assert.match(html,/Refreshing/);
});
check('chart wrapper supplies its owner context, publication and dataset status to presentation',()=>{
  const data=dataset([['A',1]]),parameters={unit:'west'},tags=[],inputs={count:4},values={privateValue:2},item=component();
  globalThis.__chartOwner={values};globalThis.__chartSample={status:'ready',data};
  const html=render(ChartComponent,{component:item,parameters,tags,inputs,scopeComponents:[item],queryScope:'runtime',publishedAt:'publication-7',communicationLost:false});
  const [sent,context,options]=globalThis.__chartDatasetArgs;assert.equal(sent,item);assert.equal(context.state,values);assert.equal(context.inputs,inputs);assert.deepEqual(options,{scope:'runtime',publishedAt:'publication-7',active:true});assert.match(html,/<svg/);
  globalThis.__chartSample={status:'error',error:'Dataset context is unavailable or disconnected.'};assert.match(render(ChartComponent,{component:item,parameters,tags,communicationLost:true}),/Dataset context is unavailable/);
});
console.log(`${passed} chart renderer checks passed.`);
