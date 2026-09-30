#!/usr/bin/env node
// Inventories only the exact staged payload and locked production dependencies.
// Generated SBOM/license material stays in the ignored release payload.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const stage = path.resolve(process.argv[2] ?? '');
const commit = process.argv[3];
const allowed = ['artifacts', '.data'].some(folder => stage.startsWith(path.join(root, folder) + path.sep));
if (!allowed || !/^[0-9a-f]{40}$/.test(commit ?? '')) throw new Error('Pass an ignored release-stage path and its source commit.');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const version = fs.readFileSync(path.join(root, 'src/SparkStudio.Gateway/SparkStudio.Gateway.csproj'), 'utf8').match(/<Version>([^<]+)</)[1];
const components = new Map();
const add = component => components.set(component['bom-ref'], component);
const browser = read(path.join(stage, 'THIRD-PARTY-NOTICES/browser-package-inventory.json'));
for (const item of browser) {
  const purl = `pkg:npm/${item.name.replace('@', '%40')}@${item.version}`;
  const hashes = item.integrity?.split(' ').filter(value => value.startsWith('sha512-')).map(value => ({ alg: 'SHA-512', content: Buffer.from(value.slice(7), 'base64').toString('hex') }));
  add({ type: 'library', name: item.name, version: item.version, 'bom-ref': purl, purl,
    ...(typeof item.license === 'string' ? { licenses: [{ expression: item.license }] } : {}),
    ...(hashes?.length ? { hashes } : {}), properties: [{ name: 'sparkstudio:notices', value: item.notices.join(';') }] });
}
const deps = read(path.join(stage, 'SparkStudio.Gateway.deps.json'));
const inventoryPath = path.join(stage, 'THIRD-PARTY-NOTICES/package-inventory.json');
const packageInventory = fs.existsSync(inventoryPath) ? read(inventoryPath) : [];
for (const [key, value] of Object.entries(deps.libraries)) {
  if (value.type !== 'package') continue;
  const slash = key.lastIndexOf('/'), name = key.slice(0, slash), version = key.slice(slash + 1);
  const purl = `pkg:nuget/${name}@${version}`;
  const notice = packageInventory.find(item => item.name === key);
  add({ type: 'library', name, version, purl, 'bom-ref': purl,
    ...(notice?.licenseType === 'expression' && notice.license ? { licenses: [{ expression: notice.license }] } : {}),
    ...(notice ? { properties: [{ name: 'sparkstudio:license-review-required', value: String(notice.requiresLicenseReview) }] } : {}),
    ...(value.sha512 ? { hashes: [{ alg: 'SHA-512', content: Buffer.from(value.sha512.replace(/^sha512-/, ''), 'base64').toString('hex') }] } : {}) });
}
const bootstrap = fs.readFileSync(path.join(root, 'tools/bootstrap.ps1'), 'utf8');
const pythonVersion = bootstrap.match(/python-(\d+\.\d+\.\d+)-embed/)[1];
const python = path.join(stage, 'runtimes/python/windows-x64/python.exe');
if (!fs.existsSync(python)) throw new Error('The exact bundled Python payload is required for its SBOM.');
add({ type: 'application', name: 'CPython', version: pythonVersion, 'bom-ref': `cpython-${pythonVersion}`, licenses: [{ license: { id: 'PSF-2.0' } }], hashes: [{ alg: 'SHA-256', content: createHash('sha256').update(fs.readFileSync(python)).digest('hex') }] });
for (const framework of read(path.join(stage, 'SparkStudio.Gateway.runtimeconfig.json')).runtimeOptions.includedFrameworks ?? []) add({ type: 'framework', name: framework.name, version: framework.version, 'bom-ref': `dotnet-${framework.name}-${framework.version}`, licenses: [{ license: { id: 'MIT' } }] });
const sorted = [...components.values()].sort((a, b) => a['bom-ref'].localeCompare(b['bom-ref']));
const bom = { bomFormat: 'CycloneDX', specVersion: '1.6', version: 1,
  metadata: { component: { type: 'application', name: 'SparkStudio', version, 'bom-ref': `sparkstudio-${version}` }, properties: [{ name: 'sparkstudio:source-commit', value: commit }] },
  components: sorted,
  dependencies: [{ ref: `sparkstudio-${version}`, dependsOn: sorted.map(item => item['bom-ref']) }],
};
fs.writeFileSync(path.join(stage, 'sbom.cdx.json'), JSON.stringify(bom, null, 2) + '\n');
console.log(`SBOM: ${sorted.length} locked/payload components.`);
