#!/usr/bin/env node
// Gateway csproj is the release version authority. --write synchronizes consumers.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
const read = name => fs.readFileSync(new URL(name, root), 'utf8');
const gateway = read('src/SparkStudio.Gateway/SparkStudio.Gateway.csproj');
const version = gateway.match(/<Version>([^<]+)<\/Version>/)?.[1];
const numeric = gateway.match(/<FileVersion>([^<]+)<\/FileVersion>/)?.[1];
if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version ?? '') || !/^\d+\.\d+\.\d+\.\d+$/.test(numeric ?? '')) throw new Error('Invalid gateway version.');
const updates = new Map();
for (const name of ['apps/web/package.json', 'apps/web/package-lock.json']) {
  const current = read(name), data = JSON.parse(current);
  data.version = version;
  if (data.packages?.['']) data.packages[''].version = version;
  updates.set(name, JSON.stringify(data, null, 2) + '\n');
}
updates.set('compose.yaml', read('compose.yaml').replace(/image: sparkstudio:[^\s]+/, `image: sparkstudio:${version}`));
updates.set('installer/SparkStudio.iss', read('installer/SparkStudio.iss').replace(/#define AppVersion "[^"]+"/, `#define AppVersion "${version}"`).replace(/#define NumericVersion "[^"]+"/, `#define NumericVersion "${numeric}"`));
let mismatches = 0;
for (const [name, expected] of updates) {
  if (read(name).replaceAll('\r\n', '\n') === expected.replaceAll('\r\n', '\n')) continue;
  if (process.argv.includes('--write')) fs.writeFileSync(new URL(name, root), expected);
  else { console.error(`Version drift: ${name}. Run node ${fileURLToPath(import.meta.url)} --write after updating the gateway version.`); mismatches++; }
}
console.log(`Release version ${version}; Windows file version ${numeric}.`);
process.exitCode = mismatches ? 1 : 0;
