import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
const source = await readFile(new URL('../apps/web/src/chartModel.ts', import.meta.url), 'utf8');
const { buildChart, chartDefinitionError, chartSegments, defaultChartProps, chartKinds } = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`);
let passed = 0;
function check(name, run) { run(); passed++; console.log(`PASS ${name}`); }
const config = { kind: 'line', xKey: 'x', series: [{ key: 'y' }] };
const dataset = rows => ({ columns: ['x', 'y'], rows: rows.map(([x, y]) => ({ x, y })) });
check('palette defaults contain valid supplied data', () => { for (const compact of [false, true]) { const props = defaultChartProps(compact); assert.equal(buildChart(props.chart, props.data).error, undefined); } });
check('all ten chart kinds are admitted with required shape', () => {
  for (const kind of chartKinds) assert.equal(chartDefinitionError({ ...config, kind, ...(kind === 'box' ? { series: ['lo', 'q1', 'mid', 'q3', 'hi'].map(key => ({ key })) } : {}), ...(kind === 'gantt' ? { endKey: 'end' } : {}) }), undefined);
});
check('invalid config types, duplicate series and unsafe bounds are rejected', () => {
  for (const patch of [{kind:'history'}, {xKey:''}, {xKey:'__proto__'}, {series:[]}, {series:[{key:'y'},{key:'y'}]}, {series:[{key:'y',color:'url(x)'}]}, {series:[{key:'y',label:7}]}, {series:Array.from({length:9},(_,i)=>({key:String(i)}))}, {yMin:Infinity}, {yMax:NaN}, {yMin:10,yMax:1}, {yMin:9007199254740992}, {showLegend:'yes'}, {kind:'box'}, {kind:'gantt'}, {kind:'pie',series:[{key:'a'},{key:'b'}]}, {script:'anything'}]) assert.ok(chartDefinitionError({...config,...patch}));
});
check('missing and bad quality retain honest line gaps instead of zeros or bridges', () => {
  const data = { columns: ['x','y','quality'], rows:[{x:'a',y:4,quality:'Good'},{x:'b',y:null,quality:'Good'},{x:'c',y:9,quality:'Bad_Disconnected'},{x:'d',y:8,quality:'Good_Local'}] };
  const model = buildChart({...config,qualityKey:'quality'}, data);
  assert.equal(model.gaps,2); assert.deepEqual(chartSegments(model.points,0).map(segment=>segment.length),[1,1]);
});
check('zero, negative and constant observations retain values with nonzero ranges', () => {
  for (const value of [0,-10,4]) { const model = buildChart(config,dataset([['a',value]])); assert.equal(model.points[0].values[0],value); assert.ok(model.yMax>model.yMin); assert.ok(model.xMax>model.xMin); }
});
check('fixed minimum or maximum expands the other axis bound', () => {
  assert.ok(buildChart({...config,yMin:100},dataset([['a',2]])).yMax>100);
  assert.ok(buildChart({...config,yMax:-100},dataset([['a',2]])).yMin< -100);
});
check('numeric XY and time axes sort copies without mutating source data', () => {
  const data=dataset([[9,2],[1,4]]), before=JSON.stringify(data); const model=buildChart({...config,kind:'scatter'},data);
  assert.deepEqual(model.points.map(point=>point.x),[1,9]); assert.equal(JSON.stringify(data),before);
  assert.equal(buildChart({...config,kind:'timeSeries'},dataset([['2026-09-30T00:00:00Z',2]])).error,undefined);
  assert.ok(buildChart({...config,kind:'timeSeries'},dataset([['2026-09-30T00:00:00',2]])).error);
  assert.ok(buildChart({...config,kind:'scatter'},dataset([['1',2]])).error);
});
check('time axes reject epochs outside JavaScript Date range', () => {
 for (const kind of ['timeSeries','gantt']) assert.ok(buildChart({...config,kind,endKey:'end'}, {columns:['x','y','end'],rows:[{x:9000000000000000,y:2,end:9000000000000001}]}).error);
});
check('bad shapes, oversized data and unknown columns fail explicitly', () => {
  for (const data of [null, {}, {columns:['x','y','y'],rows:[]}, {columns:['x'],rows:[]},dataset(Array.from({length:1001},(_,i)=>[i,2])),{columns:['x','y'],rows:[{x:'a'}]},dataset([['a','2']]),dataset([['a',true]]),dataset([['a',Infinity]]),dataset([['a',9007199254740992]])]) assert.ok(buildChart(config,data).error);
});
check('box summaries validate statistical ordering and preserve incomplete boxes as gaps', () => {
  const cfg={...config,kind:'box',series:['lo','q1','mid','q3','hi'].map(key=>({key}))}; const data={columns:['x','lo','q1','mid','q3','hi'],rows:[{x:'A',lo:0,q1:2,mid:3,q3:4,hi:8}]};
  assert.equal(buildChart(cfg,data).error,undefined); data.rows[0].mid=7; assert.ok(buildChart(cfg,data).error); data.rows[0].mid=null; assert.equal(buildChart(cfg,data).gaps,1);
});
check('Gantt validates timestamp order and uses finish in axis extent', () => {
  const cfg={...config,kind:'gantt',endKey:'end'}, data={columns:['x','y','end'],rows:[{x:1000,y:1,end:3000}]};
  assert.equal(buildChart(cfg,data).xMax,3000); data.rows[0].end=999; assert.ok(buildChart(cfg,data).error);
});
check('pie and radar reject negative values rather than changing the meaning', () => { for(const kind of ['pie','radar']) assert.ok(buildChart({...config,kind},dataset([['a',-1]])).error); });
check('range selection is bounded and slices displayed observations only', () => {
  const data=dataset(Array.from({length:100},(_,i)=>[String(i),i])); const model=buildChart(config,data,[25,50]); assert.equal(model.points.length,25); assert.equal(data.rows.length,100); assert.equal(model.points[0].label,'25');
});
check('empty rows are a valid empty state and huge ranges fail safely', () => {
  assert.equal(buildChart(config,dataset([])).points.length,0);
  assert.ok(buildChart({...config,yMin:-1.7e308,yMax:1.7e308},dataset([])).error);
});
console.log(`PASS ${passed} chart model groups`);
