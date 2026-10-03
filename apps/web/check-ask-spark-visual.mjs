import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { createTestModuleFiles } from './test-module-files.mjs';

const moduleFile = createTestModuleFiles();
const mockApi = moduleFile('export class ApiError extends Error {} export const authHeaders=()=>new Headers(); export const authenticatedFetch=()=>{throw new Error("unexpected fetch")}; export const assertAuthResponseCurrent=()=>{}; export const apiUrl=()=>"";');
const mockAuth = moduleFile('export const authSessionRevision=()=>1;');
const mockRenderer = moduleFile('export const toCanvas=()=>{throw new Error("DOM capture requires browser checks")};');
function load(name, imports) {
  return moduleFile(ts.transpileModule(fs.readFileSync(new URL(`src/${name}`, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx:ts.JsxEmit.ReactJSX },
  }).outputText.replace(/import "\.\/[^"\n]+\.css";\r?\n/g,'').replace(/from\s+"([^"]+)"/g, (_match, name) => `from ${JSON.stringify(imports[name])}`));
}
const visualUrl = load('askSparkVisual.ts', { './api':mockApi, './authSession':mockAuth, 'html-to-image':mockRenderer });
const visual = await import(visualUrl);
const cropsUrl=load('askSparkImageCrops.ts', { './api':mockApi, './authSession':mockAuth, './askSparkVisual':visualUrl });
const crops = await import(cropsUrl);
const review=await import(load('AskSparkCropReview.tsx', {'./askSparkImageCrops':cropsUrl,'react/jsx-runtime':import.meta.resolve('react/jsx-runtime')}));
let passed = 0;
async function check(name, run) { await run(); passed++; console.log(`PASS ${name}`); }
const source = { id:'sent-image', name:'Synthetic.png', mimeType:'image/png', data:'AA==', width:32, height:16, preview:'blob:ignored' };
const rectangle = (name='Part', box={x:0,y:0,width:16,height:16}) => ({ sourceImageId:source.id, name, box });
const resolveImage = id => id === source.id ? source : undefined;

await check('capture bounds preserve aspect ratio and never upscale', () => {
  assert.deepEqual(visual.captureDimensions(320,240), {width:320,height:240});
  assert.deepEqual(visual.captureDimensions(8192,4096), {width:2048,height:1024});
  for (const bad of [0,-1,Infinity,NaN,32769]) assert.throws(()=>visual.captureDimensions(bad,100), /dimensions/);
});
await check('crop rectangles use whole natural pixels and stay inside the image', () => {
  assert.equal(crops.validateCropRequests([rectangle()],resolveImage)[0].source,source);
  for (const box of [null,{}, {x:-1,y:0,width:1,height:1},{x:0,y:0,width:0,height:1},{x:0.5,y:0,width:1,height:1},{x:31,y:0,width:2,height:1},{x:0,y:16,width:1,height:1},{x:0,y:0,width:Infinity,height:1}])
    assert.throws(()=>crops.validateCropRequests([rectangle('Part',box)],resolveImage), /whole source-image pixels/);
});
await check('crop source IDs can only resolve sent images from the active conversation', () => {
  for (const id of ['https://example.test/image.png','data:image/png;base64,AA==','../asset','missing'])
    assert.throws(()=>crops.validateCropRequests([{...rectangle(),sourceImageId:id}],resolveImage), /image ID|no longer available/);
  assert.throws(()=>crops.validateCropRequests([rectangle()],()=>({...source,id:'other'})), /no longer available/);
});
await check('crop names reject paths, controls, and duplicates before any upload', () => {
  for (const name of ['', '  ', '../secret', 'part\\a', 'a\nb', 'x'.repeat(121), 'a\u007fb'])
    assert.throws(()=>crops.validateCropRequests([rectangle(name)],resolveImage), /Asset names/);
  assert.throws(()=>crops.validateCropRequests([rectangle('Part'),rectangle(' part ')],resolveImage), /unique/);
  assert.equal(crops.validateCropRequests([rectangle(' Part ')],resolveImage)[0].crop.name,'Part');
});
await check('batch and source image limits fail before browser decoding or network writes', () => {
  for (const batch of [null,{},[],Array.from({length:17},()=>rectangle())]) assert.throws(()=>crops.validateCropRequests(batch,resolveImage), /between 1 and 16/);
  for (const changes of [{mimeType:'image/svg+xml'},{data:'https://example.test'},{width:8193},{height:0},{width:8192,height:8192}])
    assert.throws(()=>crops.validateCropRequests([rectangle()],()=>({...source,...changes})), /invalid|dimensions/);
});
await check('aborted capture and crop never attempt resource access', async () => {
  const controller=new AbortController();controller.abort();
  await assert.rejects(visual.captureDesignerCanvas({},controller.signal),/abort/i);
  await assert.rejects(crops.cropRetainedImages({projectId:'project-a',crops:[rectangle()],resolveImage,signal:controller.signal}),/abort/i);
});
await check('the crop project cannot be a route or arbitrary URL', async () => {
  for (const projectId of ['../outside','https://example.test','', 'UPPER'])
    await assert.rejects(crops.cropRetainedImages({projectId,crops:[rectangle()],resolveImage,signal:new AbortController().signal}),/Open a project/);
});
await check('approval preview validates rectangle and source before constructing clipped styles',()=>{
  const resolve=id=>id===source.id?{...source,preview:'blob:synthetic-preview'}:undefined;
  const preview=review.cropPreview(rectangle(),resolve);assert.equal(preview.scale,1);assert.equal(preview.crop.box.width,16);
  assert.throws(()=>review.cropPreview(rectangle(),()=>({...source,preview:'https://example.test/image.png'})),/Only images sent/);
  assert.throws(()=>review.cropPreview(rectangle(),()=>undefined),/no longer available/);
  assert.throws(()=>review.cropPreview(rectangle('Part',{x:0,y:0,width:33,height:16}),resolve),/whole source-image pixels/);
});
await check('approval preview renders named crop tiles and safely displays malformed input',async()=>{
  const {renderToStaticMarkup}=await import('react-dom/server');const {createElement}=await import('react');
  const render=crops=>renderToStaticMarkup(createElement(review.AskSparkCropReview,{crops,resolveImage:()=>({...source,preview:'blob:synthetic-preview'})}));
  const html=render([rectangle('Red'),rectangle('Blue',{x:16,y:0,width:16,height:16})]);
  assert.match(html,/Red/);assert.match(html,/Blue/);assert.match(html,/left:-16px/);assert.match(html,/16 × 16 px source area/);assert.match(html,/512 KiB/);assert.match(html,/compressed or resized/);assert.match(html,/saved dimensions/);assert.doesNotMatch(html,/<button|<input/);
  const malformed=render([{sourceImageId:'not a URL',name:'bad'}]);assert.match(malformed,/Crop 1/);assert.doesNotMatch(malformed,/<img/);
  assert.doesNotMatch(render([rectangle('Outside',{x:32,y:0,width:16,height:16})]),/<img/);
  assert.match(render([]),/between 1 and 16/);
});

if (process.argv.includes('--browser')) await browserChecks();
console.log(`${passed} Ask Spark visual checks passed${process.argv.includes('--browser') ? ' (including actual browser pixels)' : ''}.`);

async function browserChecks() {
  const { build } = await import('esbuild');
  const playwrightPath = process.env.SPARK_PLAYWRIGHT_MODULE;
  if (!playwrightPath) throw new Error('Set SPARK_PLAYWRIGHT_MODULE to an installed Playwright index.mjs, then run with --browser.');
  const { chromium } = await import(pathToFileURL(playwrightPath));
  const bundle = await build({ stdin:{contents:'import * as visual from "./src/askSparkVisual";import * as crops from "./src/askSparkImageCrops";import {configureAuthSession} from "./src/authSession";import {ApiError} from "./src/api";window.visualTest={...visual,...crops,configureAuthSession,ApiError};',resolveDir:fileURLToPath(new URL('.',import.meta.url))},bundle:true,write:false,format:'iife',platform:'browser',target:'es2022' });
  const script=bundle.outputFiles[0].text;
  const server=createServer((request,response)=>{response.setHeader('Content-Type',request.url==='/visual.js'?'text/javascript':'text/html');response.end(request.url==='/visual.js'?script:'<!doctype html><html><head><meta charset="utf-8"></head><body><script src="/visual.js"></script></body></html>');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try {
    browser=await chromium.launch({channel:process.env.SPARK_BROWSER_CHANNEL||'msedge',headless:true});
    const page=await browser.newPage({viewport:{width:1000,height:800}});
    await page.goto(`http://127.0.0.1:${server.address().port}/designer/project-a`);
    const result=await page.evaluate(async()=>{
      const {captureDesignerCanvas,encodeCanvasCapture,cropRetainedImages,configureAuthSession,ApiError}=window.visualTest;
      const passed=[];
      const check=async(name,run)=>{await run();passed.push(name);};
      const ok=(condition,message)=>{if(!condition)throw new Error(message);};
      const expectError=async(run,pattern)=>{try{await run();throw new Error('Expected rejection');}catch(error){ok(pattern.test(error.message),`Unexpected rejection: ${error.message}`);}};
      const signal=()=>new AbortController().signal;
      configureAuthSession({audience:'engineering',projectId:'project-a',csrfToken:'synthetic-csrf',key:'synthetic-user'});
      const grid=document.createElement('canvas');grid.width=32;grid.height=16;
      const context=grid.getContext('2d');context.fillStyle='#ff0000';context.fillRect(0,0,16,16);context.fillStyle='#0000ff';context.fillRect(16,0,16,16);
      const url=grid.toDataURL('image/png');
      const source={id:'sent-image',name:'Synthetic.png',mimeType:'image/png',data:url.split(',')[1],preview:'blob:never-use',width:32,height:16};
      const resolveImage=id=>id===source.id?source:undefined;
      const crop=(name,x=0)=>({sourceImageId:source.id,name,box:{x,y:0,width:16,height:16}});
      const pixels=async(data,mimeType='image/png')=>{const image=new Image();image.src=`data:${mimeType};base64,${data}`;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);return{width:canvas.width,height:canvas.height,at:(x,y)=>[...ctx.getImageData(x,y,1,1).data]};};
      const noisySource=()=>{const canvas=document.createElement('canvas');canvas.width=512;canvas.height=512;const context=canvas.getContext('2d'),image=context.createImageData(512,512);let seed=17;for(let i=0;i<image.data.length;i++){seed=(seed*1664525+1013904223)>>>0;image.data[i]=seed>>>24;}context.putImageData(image,0,0);context.clearRect(0,0,8,8);return{...source,width:512,height:512,data:canvas.toDataURL('image/png').split(',')[1]};};
      const rgb=(value,expected)=>ok(value.slice(0,3).join(',')===expected.join(','),`Expected ${expected}, got ${value}`);
      document.body.insertAdjacentHTML('beforeend',`<style>*{box-sizing:border-box}.screen-canvas{position:relative;width:320px;height:160px;background:white;transform:scale(.5);transform-origin:top left;font-family:Arial,sans-serif}.screen-canvas button{position:absolute;left:10px;top:10px;width:80px;height:35px;background:rgb(0,128,0);color:white;border:0}.screen-canvas input{position:absolute;left:110px;top:10px;width:80px;height:35px;background:rgb(0,0,0);color:red;border:0}.screen-canvas img{position:absolute;left:10px;top:60px;width:32px;height:16px}.canvas-component-selection{position:absolute;inset:0;background:rgb(255,0,255);z-index:999}.screen-canvas .private{position:absolute;left:210px;top:10px;width:80px;height:35px;background:black}</style><div style="height:30px;background:red">Editor toolbar outside canvas</div><div class="screen-canvas snap-grid"><button>Actual button</button><input type="password" value="synthetic-secret"><div data-ask-spark-private class="private">private text</div><img src="${url}"><div class="canvas-component-selection">Selection</div></div>`);
      const canvas=document.querySelector('.screen-canvas');
      await check('real DOM capture keeps native dimensions, button and image pixels while excluding editor overlays and private inputs',async()=>{
        const capture=await captureDesignerCanvas(canvas,signal()), image=await pixels(capture.data,capture.mimeType);
        ok(capture.canvasWidth===320&&capture.canvasHeight===160&&image.width===320&&image.height===160,'Capture must undo editor zoom');
        rgb(image.at(15,15),[0,128,0]);rgb(image.at(15,65),[255,0,0]);rgb(image.at(35,65),[0,0,255]);rgb(image.at(115,15),[255,255,255]);rgb(image.at(215,15),[255,255,255]);
        ok(canvas.querySelector('input').value==='synthetic-secret'&&canvas.querySelector('.canvas-component-selection'),'Capture must not mutate source DOM');
      });
      await check('large inspection frames use smaller WebP without changing dimensions, alpha or source pixels',async()=>{
        const source=noisySource(),image=new Image();image.src=`data:${source.mimeType};base64,${source.data}`;await image.decode();
        const original=document.createElement('canvas');original.width=512;original.height=512;original.getContext('2d').drawImage(image,0,0);
        const before=original.toDataURL(),encoded=await encodeCanvasCapture(original,signal()),decoded=await pixels(encoded.data,encoded.mimeType);
        ok(encoded.mimeType==='image/webp'&&atob(encoded.data).length<atob(source.data).length,'Inspection frame was not compressed');
        ok(encoded.width===512&&encoded.height===512&&decoded.width===512&&decoded.height===512,'Compression unexpectedly resized the frame');
        ok(decoded.at(0,0)[3]===0&&original.toDataURL()===before,'Inspection compression lost alpha or changed its source');
      });
      await check('inspection frame encoding falls back to original-size PNG when WebP is unsupported',async()=>{
        const source=noisySource(),image=new Image();image.src=`data:${source.mimeType};base64,${source.data}`;await image.decode();
        const original=document.createElement('canvas');original.width=512;original.height=512;original.getContext('2d').drawImage(image,0,0);
        const native=HTMLCanvasElement.prototype.toBlob;
        HTMLCanvasElement.prototype.toBlob=function(callback,type,quality){return native.call(this,callback,type==='image/webp'?'image/png':type,quality);};
        try {
          const encoded=await encodeCanvasCapture(original,signal()),decoded=await pixels(encoded.data,encoded.mimeType);
          ok(encoded.mimeType==='image/png'&&decoded.width===512&&decoded.height===512&&decoded.at(0,0)[3]===0,'Unsupported encoding lost pixels or advertised the wrong MIME type');
        } finally { HTMLCanvasElement.prototype.toBlob=native; }
      });
      await check('browser crop encodes exact source rectangles and uploads in sequence',async()=>{
        const uploads=[];let active=0;
        const receipt=await cropRetainedImages({projectId:'project-a',crops:[crop('Red'),crop('Blue',16)],resolveImage,signal:signal(),listAssets:async()=>[],uploadAsset:async(projectId,upload)=>{ok(projectId==='project-a','Explicit project missing');ok(++active===1,'Uploads overlapped');ok(upload.contentType==='image/png','Small crop should keep lossless PNG');const image=await pixels(upload.dataBase64,upload.contentType);ok(image.width===16&&image.height===16,'Crop rescaled');rgb(image.at(8,8),upload.name==='Red'?[255,0,0]:[0,0,255]);uploads.push(upload.name);active--;return{id:'a'.repeat(64),name:upload.name,contentType:'image/png',size:100,width:16,height:16};}});
        ok(receipt.status==='completed'&&receipt.created.length===2&&uploads.join(',')==='Red,Blue','Missing ordered receipts');ok(receipt.created.every(item=>!item.resized&&item.sourceBox.width===16),'Small crops must retain source coordinates and resolution');
      });
      await check('all crop validation completes before the first upload',async()=>{
        let writes=0;const uploadAsset=async()=>{writes++;throw new Error('unexpected write');};
        await expectError(()=>cropRetainedImages({projectId:'project-a',crops:[crop('Valid'),{...crop('Outside'),box:{x:30,y:0,width:16,height:16}}],resolveImage,signal:signal(),listAssets:async()=>[],uploadAsset}),/whole source-image pixels/);
        await expectError(()=>cropRetainedImages({projectId:'project-a',crops:[crop('Existing')],resolveImage,signal:signal(),listAssets:async()=>[{name:'existing'}],uploadAsset}),/already exists/);
        await expectError(()=>cropRetainedImages({projectId:'project-a',crops:[crop('Wrong dimensions')],resolveImage:()=>({...source,width:31}),signal:signal(),listAssets:async()=>[],uploadAsset}),/dimensions changed/);
        ok(writes===0,'Validation wrote an asset');
      });
      await check('batch stops on an ambiguous second upload and returns prior success without retry',async()=>{
        let writes=0;
        const receipt=await cropRetainedImages({projectId:'project-a',crops:[crop('First'),crop('Second'),crop('Third')],resolveImage,signal:signal(),listAssets:async()=>[],uploadAsset:async(_project,upload)=>{writes++;if(writes===2)throw new TypeError('Network failed');return{id:'a'.repeat(64),name:upload.name};}});
        ok(writes===2&&receipt.status==='partial'&&receipt.created.length===1&&receipt.failed.outcome==='unknown'&&receipt.notAttempted.join(',')==='Third','Incorrect partial failure receipt');ok(/Inspect the asset library/.test(receipt.error),'Missing ambiguity warning');
      });
      await check('rejected uploads and mid-batch cancellation are distinct from unknown writes',async()=>{
        const rejected=await cropRetainedImages({projectId:'project-a',crops:[crop('Rejected')],resolveImage,signal:signal(),listAssets:async()=>[],uploadAsset:async()=>{throw new ApiError('Forbidden',403);}});
        ok(rejected.status==='failed'&&rejected.failed.outcome==='rejected','403 must be rejected');
        const cancel=new AbortController();let writes=0;
        const partial=await cropRetainedImages({projectId:'project-a',crops:[crop('First'),crop('Second')],resolveImage,signal:cancel.signal,listAssets:async()=>[],uploadAsset:async(_project,upload)=>{writes++;cancel.abort();return{id:'a'.repeat(64),name:upload.name};}});
        ok(writes===1&&partial.status==='partial'&&partial.failed.outcome==='rejected','Cancellation issued another upload');
      });
      await check('session changes stop the remaining batch',async()=>{
        let writes=0;
        const receipt=await cropRetainedImages({projectId:'project-a',crops:[crop('First'),crop('Second')],resolveImage,signal:signal(),listAssets:async()=>[],uploadAsset:async(_project,upload)=>{writes++;configureAuthSession({audience:'engineering',projectId:'project-a',csrfToken:'other-synthetic-csrf',key:'different-user'});return{id:'a'.repeat(64),name:upload.name};}});
        ok(writes===1&&receipt.status==='partial'&&/session changed/.test(receipt.error),'Account change crossed upload boundary');
      });
      await check('oversized crop PNGs use WebP at the original dimensions before downscaling',async()=>{
        const large=noisySource();let writes=0;ok(atob(large.data).length>512*1024,'Fixture must exceed the PNG asset cap');
        const receipt=await cropRetainedImages({projectId:'project-a',crops:[{...crop('Noise'),box:{x:0,y:0,width:512,height:512}}],resolveImage:()=>large,signal:signal(),listAssets:async()=>[],uploadAsset:async(_project,upload)=>{writes++;const image=await pixels(upload.dataBase64,upload.contentType),size=atob(upload.dataBase64).length;ok(upload.contentType==='image/webp'&&size<=512*1024,'Upload must use actual bounded WebP');ok(image.width===512&&image.height===512,'Compression should precede resizing');ok(image.at(0,0)[3]===0,'Transparency was lost');return{id:'a'.repeat(64),name:upload.name,contentType:upload.contentType,size,width:image.width,height:image.height};}});
        ok(writes===1&&receipt.status==='completed'&&!receipt.created[0].resized&&receipt.created[0].asset.width===512,'Missing original-size encoded receipt');
      });
      await check('unsupported WebP falls back to bounded PNG without changing the selected rectangle',async()=>{
        const large=noisySource(),native=HTMLCanvasElement.prototype.toBlob;let writes=0;
        HTMLCanvasElement.prototype.toBlob=function(callback,type,quality){return native.call(this,callback,type==='image/webp'?'image/png':type,quality);};
        try {
          const receipt=await cropRetainedImages({projectId:'project-a',crops:[{...crop('PNG fallback'),box:{x:0,y:0,width:512,height:512}}],resolveImage:()=>large,signal:signal(),listAssets:async()=>[],uploadAsset:async(_project,upload)=>{writes++;const image=await pixels(upload.dataBase64,upload.contentType),size=atob(upload.dataBase64).length;ok(upload.contentType==='image/png'&&size<=512*1024,'Fallback MIME or cap is incorrect');ok(image.width<512&&image.width===image.height,'Fallback must downscale proportionally');ok(image.at(0,0)[3]===0,'Fallback lost transparency');return{id:'a'.repeat(64),name:upload.name,contentType:upload.contentType,size,width:image.width,height:image.height};}});
          ok(writes===1&&receipt.status==='completed'&&receipt.created[0].resized&&receipt.created[0].sourceBox.width===512,'Fallback must report saved dimensions and original source area');
        } finally { HTMLCanvasElement.prototype.toBlob=native; }
      });
      await check('compression failures prepare the whole batch before uploading and never retry uploads',async()=>{
        const native=HTMLCanvasElement.prototype.toBlob;let encodes=0,writes=0;
        HTMLCanvasElement.prototype.toBlob=function(callback,type,quality){const oversized=++encodes>1;return native.call(this,blob=>callback(oversized?new Blob([blob,new Uint8Array(512*1024)],{type:blob.type}):blob),type,quality);};
        try {
          await expectError(()=>cropRetainedImages({projectId:'project-a',crops:[crop('Prepared'),crop('Cannot fit')],resolveImage,signal:signal(),listAssets:async()=>[],uploadAsset:async()=>{writes++;}}),/512 KiB/);
          ok(writes===0&&encodes<=37,'Compression must be bounded and precede every upload');
        } finally { HTMLCanvasElement.prototype.toBlob=native; }
      });
      await check('external canvas resources fail closed before export',async()=>{
        const part=document.createElement('div');part.style.backgroundImage='url(https://example.invalid/external.png)';canvas.append(part);
        await expectError(()=>captureDesignerCanvas(canvas,signal()),/External resources must be imported/);part.remove();
      });
      return passed;
    });
    for(const name of result) await check(name,()=>{});
    await check('default asset upload uses explicit project route and authenticated CSRF header',async()=>{
      let request;
      await page.route('**/api/projects/project-b/assets',async route=>{request=route.request();await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({id:'a'.repeat(64),name:'Synthetic',contentType:'image/png',size:100,width:16,height:16})});});
      await page.evaluate(async()=>{await window.visualTest.uploadProjectAsset('project-b',{name:'Synthetic',contentType:'image/png',dataBase64:'AA=='},new AbortController().signal);});
      assert.equal(request.method(),'POST');assert.equal(request.headers()['x-spark-audience'],'engineering');assert.equal(request.headers()['x-spark-csrf'],'other-synthetic-csrf');assert.equal(request.postDataJSON().name,'Synthetic');
    });
    await check('same-origin canvas images are embedded with authenticated resource reads',async()=>{
      const imageData=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=4;canvas.height=4;const context=canvas.getContext('2d');context.fillStyle='#f00';context.fillRect(0,0,4,4);return canvas.toDataURL().split(',')[1];});
      const requests=[];
      await page.route('**/protected.png',async route=>{requests.push(route.request().headers());await route.fulfill({status:200,contentType:'image/png',body:Buffer.from(imageData,'base64')});});
      const result=await page.evaluate(async()=>{const root=document.querySelector('.screen-canvas'),image=root.querySelector('img');image.src='/protected.png';await image.decode();const capture=await window.visualTest.captureDesignerCanvas(root,new AbortController().signal);const decoded=new Image();decoded.src=`data:${capture.mimeType};base64,${capture.data}`;await decoded.decode();const canvas=document.createElement('canvas');canvas.width=decoded.naturalWidth;canvas.height=decoded.naturalHeight;const context=canvas.getContext('2d');context.drawImage(decoded,0,0);return[...context.getImageData(15,65,1,1).data];});
      assert.deepEqual(result,[255,0,0,255]);assert.ok(requests.filter(headers=>headers['x-spark-audience']==='engineering').length>=2,'Preflight and embed should carry engineering authentication');
    });
  } finally { await browser?.close(); await new Promise(resolve=>server.close(resolve)); }
}
