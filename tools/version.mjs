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
// The published Docker edition is maintained by a separate Docker release.
// A Windows version bump must not point Compose at an image that does not exist.
const dockerEdition = read('compose.yaml').match(/image: \$\{SPARKSTUDIO_IMAGE:-ladder99\/sparkstudio:([^}]+)\}/)?.[1];
if (!/^\d+\.\d+\.\d+-preview\.\d+-docker\.\d+$/.test(dockerEdition ?? '')) throw new Error('Compose must pin a deliberate published Docker preview edition.');
if (read('Dockerfile').match(/^ARG CONTAINER_EDITION=([^\s]+)$/m)?.[1] !== dockerEdition) throw new Error('Dockerfile and Compose Docker edition defaults differ.');
updates.set('installer/SparkStudio.iss', read('installer/SparkStudio.iss').replace(/#define AppVersion "[^"]+"/, `#define AppVersion "${version}"`).replace(/#define NumericVersion "[^"]+"/, `#define NumericVersion "${numeric}"`));
let mismatches = 0;
for (const [name, expected] of updates) {
  if (read(name).replaceAll('\r\n', '\n') === expected.replaceAll('\r\n', '\n')) continue;
  if (process.argv.includes('--write')) fs.writeFileSync(new URL(name, root), expected);
  else { console.error(`Version drift: ${name}. Run node ${fileURLToPath(import.meta.url)} --write after updating the gateway version.`); mismatches++; }
}
console.log(`Release version ${version}; Windows file version ${numeric}.`);
process.exitCode = mismatches ? 1 : 0;
