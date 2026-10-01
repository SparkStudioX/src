// Load authored browser models for offline checks, including their shared JSON
// schemas. No browser, network, generated source copies or application state.
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const cache = new Map();
export async function webModelModule(name) {
  if (!/^[A-Za-z0-9_-]+(?:\.json)?$/.test(name)) throw new Error('Invalid model module name.');
  if (cache.has(name)) return cache.get(name);
  const source = await readFile(new URL(`../apps/web/src/${name.endsWith('.json') ? name : name + '.ts'}`, import.meta.url), 'utf8');
  let output = name.endsWith('.json') ? 'export default ' + JSON.stringify(JSON.parse(source)) : stripTypeScriptTypes(source);
  for (const match of [...output.matchAll(/from\s+(["'])\.\/([^"']+)\1/g)]) {
    output = output.replace(match[0], `from ${JSON.stringify(await webModelModule(match[2]))}`);
  }
  const url = 'data:text/javascript;base64,' + Buffer.from(output).toString('base64');
  cache.set(name, url);
  return url;
}
