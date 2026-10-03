import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { createTestModuleFiles } from './test-module-files.mjs';

const require = createRequire(import.meta.url), moduleFile = createTestModuleFiles();
const source = fs.readFileSync(new URL('src/AskSparkMarkdown.tsx', import.meta.url), 'utf8');
function compile(overrides = {}) {
  return moduleFile(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText
    .replace(/import "\.\/[^"\n]+\.css";\r?\n/g, '')
    .replace(/(from\s+)(["'])([^"']+)\2/g, (_all, prefix, _quote, name) => prefix + JSON.stringify(overrides[name] || pathToFileURL(require.resolve(name)).href)));
}
const { default: AskSparkMarkdown, safeAskSparkMarkdownUrl } = await import(compile());
const render = text => renderToStaticMarkup(React.createElement(AskSparkMarkdown, { text }));
let passed = 0;
async function check(name, run) { await run(); passed++; console.log(`PASS ${name}`); }

await check('assistant Markdown renders semantic headings, paragraphs, emphasis, lists and quotes', () => {
  const html = render('# Connection guide\n\nUse **MQTT** with *care*.\n\n1. Create a connection\n2. Save it\n\n- Browse\n- Import\n\n> Review the mapping.');
  for (const expected of ['<h1>Connection guide</h1>', '<strong>MQTT</strong>', '<em>care</em>', '<ol>', '<ul>', '<li>Save it</li>', '<blockquote>', '<p>Review the mapping.</p>']) assert.ok(html.includes(expected), expected);
});
await check('inline and fenced code remain text, preserve indentation and provide explicit copy', () => {
  const html = render('Use `tag.value`.\n\n```javascript\nif (ready) {\n  write("<script>not executable</script>");\n}\n```');
  assert.match(html, /<code>tag\.value<\/code>/); assert.match(html, /class="language-javascript"/); assert.ok(html.includes('  write(&quot;&lt;script&gt;not executable&lt;/script&gt;&quot;);')); assert.match(html, /aria-label="Copy code"/); assert.match(html, /<pre[^>]+tabindex="0"/); assert.ok(!html.includes('<script>'));
  assert.match(render('```\nunfinished fence'), /<pre[^>]*><code>unfinished fence/);
});
await check('GFM tables, strikethrough, autolinks and read-only task lists render', () => {
  const html = render('| Protocol | Read |\n| :-- | --: |\n| MQTT | Yes |\n| OPC UA | Yes |\n\n~~old~~ https://example.test/docs\n\n- [x] Connected\n- [ ] Browse');
  assert.match(html, /role="region"[^>]+aria-label="Table; scroll horizontally to see more columns"[^>]+tabindex="0"/); assert.match(html, /<table><thead>/); assert.match(html, /<th[^>]*>Protocol<\/th>/); assert.match(html, /<td[^>]*>MQTT<\/td>/); assert.match(html, /<del>old<\/del>/); assert.match(html, /href="https:\/\/example.test\/docs"/); assert.equal((html.match(/type="checkbox"/g) || []).length, 2); assert.equal((html.match(/disabled=""/g) || []).length, 2);
});
await check('raw HTML and executable resource elements never become active markup', () => {
  const html = render('<script>alert(1)</script>\n\n<iframe src="https://example.test/frame"></iframe>\n\n<img src="https://example.test/pixel" onerror="alert(1)">\n\n<svg onload="alert(1)"></svg>\n\n**Still readable**');
  assert.ok(!/<(?:script|iframe|img|svg|object|embed|style|link)\b/i.test(html)); assert.ok(!/onerror|onload|src=/i.test(html)); assert.match(html, /<strong>Still readable<\/strong>/);
});
await check('dangerous, malformed and credential-bearing URLs cannot become clickable links', () => {
  for (const unsafe of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,test', 'vbscript:msgbox(1)', 'file:///C:/private', 'blob:https://example.test/id', 'https://user:password@example.test', 'https://bad\\example.test', 'java\nscript:alert(1)', 'https://example.test/ with space']) assert.equal(safeAskSparkMarkdownUrl(unsafe), undefined, unsafe);
  const html = render('[unsafe](javascript:alert%281%29) [data](data:text/html,bad) [file](file:///tmp/a) [encoded](jav&#x61;script:alert%281%29)');
  assert.ok(!html.includes('<a ')); assert.ok(html.includes('unsafe')); assert.ok(html.includes('encoded'));
});
await check('ordinary links are explicit navigation with no opener or referrer exposure', () => {
  for (const safe of ['https://example.test/docs?q=one', 'http://127.0.0.1:6090/gateway', '/gateway#ai', '#note', 'mailto:help@example.test']) assert.equal(safeAskSparkMarkdownUrl(safe), safe);
  const html = render('[Documentation](https://example.test/docs "Guide")');
  assert.match(html, /href="https:\/\/example.test\/docs"/); assert.match(html, /target="_blank"/); assert.match(html, /rel="noopener noreferrer"/); assert.match(html, /referrerPolicy="no-referrer"/); assert.match(html, /title="Guide"/);
});
await check('Markdown images render only as links, never images or browser preload requests', () => {
  const html = render('![Diagram](https://example.test/diagram.png)\n\n![Hidden payload](data:image/svg+xml,bad)');
  assert.ok(!/<(?:img|link)\b/i.test(html)); assert.ok(!/\bsrc=/.test(html)); assert.match(html, /href="https:\/\/example.test\/diagram.png"/); assert.ok(html.includes('Image: Diagram')); assert.ok(html.includes('Image: Hidden payload')); assert.ok(!html.includes('data:image'));
});
await check('footnote IDs are scoped separately for each response', () => {
  const html = renderToStaticMarkup(React.createElement('div', null, React.createElement(AskSparkMarkdown, { text: 'First[^note]\n\n[^note]: One' }), React.createElement(AskSparkMarkdown, { text: 'Second[^note]\n\n[^note]: Two' })));
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map(match => match[1]); assert.equal(new Set(ids).size, ids.length); assert.equal(ids.filter(id => id.endsWith('fn-note')).length, 2);
  for (const match of html.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.includes(match[1]));
  for (const match of html.matchAll(/aria-describedby="([^"]+)"/g)) assert.ok(ids.includes(match[1]));
});

const hooksUrl = moduleFile('let message="";export const block={current:{textContent:"  exact code\\n"}};export const useRef=()=>block;export const useState=()=>[message,next=>{message=next}];export const useId=()=>"test";');
const { AskSparkCodeBlock } = await import(compile({ react: hooksUrl }));
const descendants = node => !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(3).flatMap(descendants)];
await check('Copy code writes only the literal code after the button is activated and reports denial', async () => {
  const writes = []; Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async text => { writes.push(text); } } } });
  let tree = AskSparkCodeBlock({ children: 'fixture' }); assert.deepEqual(writes, []); descendants(tree).find(node => node.type === 'button').props.onClick(); await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(writes, ['  exact code\n']); tree = AskSparkCodeBlock({ children: 'fixture' }); assert.equal(descendants(tree).find(node => node.props?.role === 'status').props.children, 'Copied');
  navigator.clipboard.writeText = async () => { throw new Error('Denied'); }; descendants(tree).find(node => node.type === 'button').props.onClick(); await new Promise(resolve => setImmediate(resolve)); tree = AskSparkCodeBlock({ children: 'fixture' }); assert.match(descendants(tree).find(node => node.props?.role === 'status').props.children, /Copy unavailable/);
});
console.log(`${passed} Ask Spark Markdown checks passed.`);
