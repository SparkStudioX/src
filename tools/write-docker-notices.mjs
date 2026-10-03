#!/usr/bin/env node
// Inventories the published Linux payload and actual final-image runtimes.
// Only original attribution texts enter the generated payload. This does not
// copy package source, development node_modules, or NuGet caches into an image.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { reviewedSupplements, reviewedBundledLicenses } from './package-notice-supplements.mjs';

const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const hash = value => createHash('sha256').update(value).digest('hex');
const slash = value => value.split(path.sep).join('/');
const noticePattern = /^(LICENSE|LICENCE|COPYING|NOTICE|ThirdPartyNotices?|THIRD-PARTY-NOTICES?)([.-]|$)/i;

function relativeFile(root, relative) {
  if (typeof relative !== 'string' || relative.includes('\\') || relative.startsWith('/') || relative.split('/').some(piece => !piece || piece === '.' || piece === '..')) throw new Error(`Invalid relative package path: ${relative}`);
  const result = path.resolve(root, relative);
  if (!result.startsWith(path.resolve(root) + path.sep)) throw new Error('Package file escaped its root.');
  return result;
}

function filesUnder(root, omitNestedPackages = false) {
  const files = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Distribution package contains a file link: ${file}`);
      if (entry.isDirectory()) {
        if (!omitNestedPackages || entry.name !== 'node_modules') visit(file);
      } else if (entry.isFile()) files.push(file);
    }
  }
  visit(root);
  return files.sort();
}

function copyNotice(file, destination, notices) {
  if (!noticePattern.test(path.basename(destination)) && path.basename(destination) !== 'copyright') throw new Error(`Only original notice files may be retained: ${file}`);
  const content = fs.readFileSync(file);
  if (!content.length || content.length > 2 * 1024 * 1024) throw new Error(`Invalid notice length: ${file}`);
  const target = relativeFile(notices, destination);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return { path: destination, sha256: hash(content) };
}

function decodeXml(value) {
  return value.replace(/&(quot|apos|amp|lt|gt);/g, (_, entity) => ({ quot: '"', apos: "'", amp: '&', lt: '<', gt: '>' })[entity]);
}

export function readPackageMetadata(xml) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Package metadata cannot contain XML entities.');
  const element = name => {
    const match = xml.match(new RegExp(`<${name}\\b([^>]*)>([^<]*)</${name}>`, 'i'));
    return match ? { value: decodeXml(match[2].trim()), attributes: attributes(match[1]) } : null;
  };
  function attributes(text) {
    return Object.fromEntries([...text.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g)].map(match => [match[1], decodeXml(match[3])]));
  }
  const license = element('license');
  const repository = xml.match(/<repository\b([^>]*)\/?\s*>/i);
  const repo = repository ? attributes(repository[1]) : {};
  return { id: element('id')?.value, version: element('version')?.value, license: license?.value ?? null, licenseType: license?.attributes.type ?? null, licenseUrl: element('licenseUrl')?.value ?? null, copyright: element('copyright')?.value ?? null, repository: repo.url ?? null, repositoryCommit: repo.commit ?? null };
}

export function validateReviewedMetadata(identity, metadata, packageDirectory) {
  const supplement = reviewedSupplements.get(identity);
  if (supplement) {
    const licenseMatches = supplement.licenseDeclarationAbsent === true
      ? metadata.licenseType === null && metadata.license === null
      : metadata.licenseType === 'expression' && metadata.license === supplement.license;
    if (!licenseMatches || (metadata.repository && metadata.repository.toLowerCase() !== `https://github.com/${supplement.repository}`.toLowerCase()) || (metadata.repositoryCommit && metadata.repositoryCommit !== supplement.revision)) throw new Error(`Package metadata differs from its reviewed notice supplement: ${identity}`);
    return supplement.license;
  }
  const bundled = reviewedBundledLicenses.get(identity);
  if (!bundled) throw new Error(`Package version requires a distribution license review: ${identity}`);
  const original = relativeFile(packageDirectory, bundled.file);
  if (!fs.existsSync(original) || hash(fs.readFileSync(original)) !== bundled.sha256) throw new Error(`Original package license differs from its review: ${identity}`);
  if (metadata.licenseType === 'expression' && metadata.license !== bundled.license) throw new Error(`Package license declaration differs from its review: ${identity}`);
  if (metadata.licenseType === 'file' && metadata.license !== bundled.file) throw new Error(`Package license file differs from its review: ${identity}`);
  return bundled.license;
}

async function reviewedUpstreamFile(spec, name, checksum, cache) {
  const url = `https://raw.githubusercontent.com/${spec.repository}/${spec.revision}/${name}`;
  const file = path.join(cache, spec.repository, spec.revision, name.replaceAll('/', '__'));
  if (!fs.existsSync(file)) {
    const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`Cannot fetch original upstream notice: ${url} (${response.status})`);
    const declaredLength = Number(response.headers.get('content-length') ?? 0);
    if (declaredLength > 131072) throw new Error('Upstream notice exceeds the reviewed size bound.');
    const content = Buffer.from(await response.arrayBuffer());
    if (content.length > 131072 || hash(content) !== checksum) throw new Error(`Upstream notice differs from its reviewed checksum: ${url}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  if (hash(fs.readFileSync(file)) !== checksum) throw new Error(`Cached upstream notice differs from its reviewed checksum: ${url}`);
  return { file, url, sha256: checksum, sourceRevision: spec.revision };
}

export function verifyNugetIntegrity(directory, name, version, lockedHash) {
  const restored = read(path.join(directory, '.nupkg.metadata'));
  if (lockedHash !== `sha512-${restored.contentHash}`) throw new Error(`Published package does not match its locked restored integrity: ${name}/${version}`);
  // Signed NuGet archives have a different complete-archive hash than their
  // normalized lockfile content hash. Preserve and verify both identities.
  const archive = path.join(directory, `${name.toLowerCase()}.${version.toLowerCase()}.nupkg`);
  const archiveHash = createHash('sha512').update(fs.readFileSync(archive)).digest('base64');
  if (fs.readFileSync(`${archive}.sha512`, 'utf8').trim() !== archiveHash) throw new Error(`Restored package archive integrity changed: ${name}/${version}`);
  return `sha512-${archiveHash}`;
}

async function nugetInventory(payload, nuget, notices, cache) {
  const deps = read(path.join(payload, 'SparkStudio.Gateway.deps.json'));
  const worker = path.join(payload, 'source-worker', 'SparkStudio.SourceWorker.deps.json');
  if (fs.existsSync(worker)) Object.assign(deps.libraries, read(worker).libraries);
  const packages = [];
  for (const [identity, library] of Object.entries(deps.libraries).sort()) {
    if (library.type !== 'package') continue;
    const slashIndex = identity.lastIndexOf('/');
    const name = identity.slice(0, slashIndex), version = identity.slice(slashIndex + 1);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || !/^\d+\.\d+\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.+-]+)?$/.test(version)) throw new Error('Invalid NuGet package identity.');
    if (library.path !== `${name.toLowerCase()}/${version.toLowerCase()}`) throw new Error(`Unexpected NuGet package cache path: ${identity}`);
    const directory = relativeFile(nuget, library.path);
    const nuspecs = fs.readdirSync(directory).filter(file => file.endsWith('.nuspec'));
    if (nuspecs.length !== 1) throw new Error(`Expected exact package metadata for ${identity}.`);
    const metadata = readPackageMetadata(fs.readFileSync(path.join(directory, nuspecs[0]), 'utf8'));
    if (metadata.id !== name || metadata.version !== version) throw new Error(`Package metadata identity mismatch: ${identity}`);
    const archiveHash = verifyNugetIntegrity(directory, name, version, library.sha512);
    const reviewedLicense = validateReviewedMetadata(identity, metadata, directory);
    const entry = { name: identity, type: 'package', hash: library.sha512, archiveHash, ...metadata, reviewedLicense, noticeFiles: [], noticeHashes: [], requiresLicenseReview: false };
    for (const original of filesUnder(directory).filter(file => noticePattern.test(path.basename(file)))) {
      const relative = `nuget/${identity}/${slash(path.relative(directory, original))}`;
      entry.noticeHashes.push(copyNotice(original, relative, notices));
      entry.noticeFiles.push(relative);
    }
    const spec = reviewedSupplements.get(identity);
    if (spec) {
      entry.reviewedNoticeSources = [];
      if (spec.sourceAvailability) {
        entry.sourceAvailability = spec.sourceAvailability;
        const relative = `nuget/${identity}/SOURCE-AVAILABILITY.txt`;
        const destination = path.join(notices, relative);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, `Source code for the unmodified libraries distributed in ${identity} is available under ${spec.license} at:\n${spec.sourceAvailability.join('\n')}\n`);
        entry.noticeFiles.push(relative);
        entry.noticeHashes.push({ path: relative, sha256: hash(fs.readFileSync(destination)) });
      }
      for (const [name, checksum] of spec.files) {
        const upstream = await reviewedUpstreamFile(spec, name, checksum, cache);
        const relative = `nuget/${identity}/upstream/${name}`;
        entry.noticeHashes.push(copyNotice(upstream.file, relative, notices));
        entry.noticeFiles.push(relative);
        entry.reviewedNoticeSources.push({ url: upstream.url, sha256: upstream.sha256, sourceRevision: upstream.sourceRevision });
      }
    }
    if (!entry.noticeFiles.length) throw new Error(`No original redistribution notices accompany ${identity}.`);
    packages.push(entry);
  }
  if (!packages.length) throw new Error('Published NuGet dependency inventory is empty.');
  return packages;
}

function browserInventory(web, notices, version) {
  const lock = read(path.join(web, 'package-lock.json'));
  if (lock.packages['']?.version !== version) throw new Error('Browser and image product versions do not match.');
  const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(command, ['ls', '--omit=dev', '--all', '--parseable'], { cwd: web, encoding: 'utf8', shell: process.platform === 'win32' });
  if (result.status !== 0) throw new Error(`Cannot inventory installed browser production dependencies: ${result.stderr}`);
  const packages = [];
  for (const directory of [...new Set(result.stdout.trim().split(/\r?\n/))].sort()) {
    if (path.resolve(directory) === path.resolve(web)) continue;
    const relative = slash(path.relative(web, directory));
    if (!relative.startsWith('node_modules/') || relative.includes('../') || fs.lstatSync(directory).isSymbolicLink()) throw new Error('Browser dependency is outside its installed package directory.');
    const metadata = read(path.join(directory, 'package.json'));
    const locked = lock.packages[relative];
    if (!locked || locked.version !== metadata.version || locked.dev || metadata.license !== 'MIT' || !/^sha512-[A-Za-z0-9+/]+=*$/.test(locked.integrity ?? '')) throw new Error(`Browser dependency requires review or differs from its lock: ${metadata.name}`);
    if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(metadata.name) || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.+-]+)?$/.test(metadata.version)) throw new Error('Invalid browser package identity.');
    const entry = { name: metadata.name, version: metadata.version, license: metadata.license, integrity: locked.integrity, notices: [], noticeHashes: [] };
    for (const original of filesUnder(directory, true).filter(file => noticePattern.test(path.basename(file)) && ['', '.txt', '.md'].includes(path.extname(file).toLowerCase()))) {
      const relative = `browser/${metadata.name}/${metadata.version}/${slash(path.relative(directory, original))}`;
      entry.noticeHashes.push(copyNotice(original, relative, notices));
      entry.notices.push(relative);
    }
    if (!entry.notices.length) throw new Error(`No original license accompanies ${metadata.name}.`);
    packages.push(entry);
  }
  if (!packages.length) throw new Error('Browser production dependency inventory is empty.');
  return packages;
}

function runtimeInventory(runtime, notices, architecture) {
  const inventory = read(path.join(runtime, 'runtime-inventory.json'));
  const expectedMachine = architecture === 'amd64' ? 'x86_64' : 'aarch64';
  if (inventory.formatVersion !== 1 || inventory.platform !== `linux/${expectedMachine}` || !inventory.frameworks?.length || !inventory.osPackages?.length || !/^\d+\.\d+\.\d+$/.test(inventory.python?.version ?? '')) throw new Error('Runtime inventory does not match the target image architecture.');
  const originals = [...inventory.runtimeNotices, ...inventory.python.notices, ...inventory.commonLicenses, ...inventory.osPackages.flatMap(item => item.notices)];
  for (const original of originals) {
    const source = relativeFile(runtime, original.path);
    if (hash(fs.readFileSync(source)) !== original.sha256) throw new Error(`Runtime original changed after collection: ${original.path}`);
    const destination = relativeFile(notices, `runtime/${original.path}`);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
  fs.writeFileSync(path.join(notices, 'runtime-inventory.json'), JSON.stringify(inventory, null, 2) + '\n');
  return inventory;
}

function sbom(packages, browser, runtime, options) {
  const components = [];
  for (const item of packages) {
    const ref = `pkg:nuget/${item.id}@${item.version}`;
    components.push({ type: 'library', name: item.id, version: item.version, purl: ref, 'bom-ref': ref, licenses: [{ expression: item.reviewedLicense }], hashes: [{ alg: 'SHA-512', content: Buffer.from(item.archiveHash.slice(7), 'base64').toString('hex') }], properties: [{ name: 'sparkstudio:notices', value: item.noticeFiles.join(';') }, { name: 'sparkstudio:nuget-lock-content-hash', value: item.hash }, { name: 'sparkstudio:license-review-required', value: 'false' }] });
  }
  for (const item of browser) {
    const ref = `pkg:npm/${item.name.replace('@', '%40')}@${item.version}`;
    components.push({ type: 'library', name: item.name, version: item.version, purl: ref, 'bom-ref': ref, licenses: [{ expression: item.license }], properties: [{ name: 'sparkstudio:notices', value: item.notices.join(';') }], hashes: [{ alg: 'SHA-512', content: Buffer.from(item.integrity.replace(/^sha512-/, ''), 'base64').toString('hex') }] });
  }
  for (const framework of runtime.frameworks) components.push({ type: 'framework', name: framework.name, version: framework.version, 'bom-ref': `dotnet-${framework.name}-${framework.version}`, licenses: [{ expression: 'MIT' }], properties: [{ name: 'sparkstudio:notices', value: runtime.runtimeNotices.map(item => `runtime/${item.path}`).join(';') }] });
  components.push({ type: 'application', name: 'CPython', version: runtime.python.version, 'bom-ref': `cpython-${runtime.python.version}`, licenses: [{ expression: 'PSF-2.0' }], properties: [{ name: 'sparkstudio:notices', value: runtime.python.notices.map(item => `runtime/${item.path}`).join(';') }] });
  for (const item of runtime.osPackages) {
    const purl = `pkg:deb/ubuntu/${item.name}@${encodeURIComponent(item.version)}?arch=${item.architecture}&distro=ubuntu-24.04`;
    components.push({ type: 'library', name: item.name, version: item.version, purl, 'bom-ref': purl, properties: [{ name: 'sparkstudio:notices', value: item.notices.map(notice => `runtime/${notice.path}`).join(';') }, { name: 'sparkstudio:source-package', value: item.sourcePackage }, { name: 'sparkstudio:source-version', value: item.sourceVersion }] });
  }
  const ref = `sparkstudio-${options.version}-${options.architecture}`;
  components.sort((a, b) => a['bom-ref'].localeCompare(b['bom-ref']));
  return { bomFormat: 'CycloneDX', specVersion: '1.6', version: 1, metadata: { component: { type: 'application', name: 'SparkStudio', version: options.version, 'bom-ref': ref }, properties: [{ name: 'sparkstudio:source-commit', value: options['source-commit'] }, { name: 'sparkstudio:container-edition', value: options['container-edition'] }, { name: 'sparkstudio:platform', value: `linux/${options.architecture}` }] }, components, dependencies: [{ ref, dependsOn: components.map(item => item['bom-ref']) }] };
}

export async function writeDockerNotices(options) {
  if (!/^[0-9a-f]{40}$/.test(options['source-commit'] ?? '') || !['amd64', 'arm64'].includes(options.architecture) || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(options.version ?? '') || !/^[A-Za-z0-9][A-Za-z0-9._-]+$/.test(options['container-edition'] ?? '')) throw new Error('Explicit version, container edition, source commit and supported architecture are required.');
  const bases = {};
  for (const name of ['runtime', 'python', 'sdk', 'node']) {
    const value = options[`${name}-image`];
    if (!/^[A-Za-z0-9][A-Za-z0-9./:_-]+@sha256:[0-9a-f]{64}$/.test(value ?? '')) throw new Error(`Pinned ${name} base image reference is required.`);
    bases[name] = value;
  }
  const payload = path.resolve(options.payload), notices = path.join(payload, 'THIRD-PARTY-NOTICES');
  const deps = read(path.join(payload, 'SparkStudio.Gateway.deps.json'));
  if (deps.libraries[`SparkStudio.Gateway/${options.version}`]?.type !== 'project') throw new Error('Published gateway and image product versions do not match.');
  if (fs.existsSync(notices)) throw new Error('Notice output must be freshly generated from this build.');
  fs.mkdirSync(notices);
  const packages = await nugetInventory(payload, path.resolve(options.nuget), notices, path.resolve(options.cache ?? path.join(os.tmpdir(), 'sparkstudio-original-notices')));
  const browser = browserInventory(path.resolve(options.web), notices, options.version);
  const runtime = runtimeInventory(path.resolve(options.runtime), notices, options.architecture);
  fs.writeFileSync(path.join(notices, 'package-inventory.json'), JSON.stringify(packages, null, 2) + '\n');
  fs.writeFileSync(path.join(notices, 'browser-package-inventory.json'), JSON.stringify(browser, null, 2) + '\n');
  const bom = sbom(packages, browser, runtime, options);
  fs.writeFileSync(path.join(payload, 'sbom.cdx.json'), JSON.stringify(bom, null, 2) + '\n');
  const files = filesUnder(payload).filter(file => path.basename(file) !== 'container-manifest.json').map(file => ({ path: slash(path.relative(payload, file)), size: fs.statSync(file).size, sha256: hash(fs.readFileSync(file)) }));
  const index = fs.readFileSync(path.join(payload, 'wwwroot/index.html'), 'utf8');
  const entry = index.match(/\/assets\/index-[A-Za-z0-9_-]+\.js/)?.[0];
  if (!entry) throw new Error('Published browser entry is missing.');
  const browserEntry = files.find(file => file.path === `wwwroot${entry}`);
  if (!browserEntry) throw new Error('Published browser entry does not exist in the payload.');
  const manifest = { formatVersion: 1, product: 'SparkStudio', version: options.version, containerEdition: options['container-edition'], platform: `linux/${options.architecture}`, sourceCommit: options['source-commit'], baseImages: bases, browser: { entry, sha256: browserEntry.sha256 }, frameworks: runtime.frameworks, python: runtime.python.version, sbom: 'sbom.cdx.json', files };
  fs.writeFileSync(path.join(payload, 'container-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Docker payload: ${options.architecture}; ${packages.length} NuGet, ${browser.length} browser, ${runtime.osPackages.length} OS packages; ${bom.components.length} SBOM components; original notices retained.`);
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const options = {};
  for (let index = 2; index < process.argv.length; index += 2) {
    const name = process.argv[index];
    if (!name.startsWith('--') || !process.argv[index + 1]) throw new Error('Pass paired --name value arguments.');
    options[name.slice(2)] = process.argv[index + 1];
  }
  await writeDockerNotices(options);
}
