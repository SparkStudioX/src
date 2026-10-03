#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readPackageMetadata, validateBrowserLicense, validateReviewedMetadata, verifyNugetIntegrity, writeDockerNotices } from './write-docker-notices.mjs';
import { reviewedSupplements } from './package-notice-supplements.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = name => fs.readFileSync(path.join(root, name), 'utf8');
const workerProject = source('src/SparkStudio.SourceWorker/SparkStudio.SourceWorker.csproj');
assert.match(workerProject, /<PackageReference Include="Scriban" Version="7[.]5[.]0"\s*\/>/);
assert.match(workerProject, /<PublishTrimmed>false<\/PublishTrimmed>/);
assert.match(workerProject, /<PublishSingleFile>false<\/PublishSingleFile>/);
let scribanHash;
for (const rid of ['', '.win-x64', '.linux-x64', '.linux-arm64']) {
  const lock = JSON.parse(source(`src/SparkStudio.SourceWorker/packages${rid}.lock.json`));
  const entry = Object.values(lock.dependencies).map(target => target.Scriban).find(Boolean);
  assert.equal(entry?.resolved, '7.5.0', `Source worker ${rid || 'portable'} restore locks the qualified Scriban version.`);
  assert.equal(entry.type, 'Direct'); assert.match(entry.contentHash, /^[A-Za-z0-9+/]{86}==$/);
  scribanHash ??= entry.contentHash; assert.equal(entry.contentHash, scribanHash, 'The same reviewed Scriban package is used for every supported RID.');
}
const gatewayProject = source('src/SparkStudio.Gateway/SparkStudio.Gateway.csproj');
assert.match(gatewayProject, /ProjectReference Include="[.]\.\/SparkStudio[.]SourceWorker\/SparkStudio[.]SourceWorker[.]csproj"[^>]*ReferenceOutputAssembly="false"/);
const workerPublish = gatewayProject.match(/<Target\b[^>]*AfterTargets="Publish"[^>]*>[\s\S]*?SparkStudio[.]SourceWorker[\s\S]*?<\/Target>/)?.[0];
assert.ok(workerPublish, 'A gateway publish includes the separately executable source worker.');
assert.match(workerPublish, /RuntimeIdentifier=\$\(RuntimeIdentifier\)/);
assert.match(workerPublish, /PublishDir=[^"\r\n]*source-worker\//);
assert.match(workerPublish, /PublishSingleFile=false;PublishTrimmed=false/);
const dockerfile = source('Dockerfile');
assert.match(dockerfile, /COPY src\/ [.]\/src\//);
assert.match(dockerfile, /dotnet publish src\/SparkStudio[.]Gateway/);
assert.match(dockerfile, /COPY --from=build \/out \/out/);
assert.match(dockerfile, /COPY --from=notices \/out [.]\//);
const metadata = readPackageMetadata('<package><metadata><id>AWSSDK.S3</id><version>4.0.104</version><license type="expression">Apache-2.0</license><repository url="https://github.com/aws/aws-sdk-net" commit="f5257515bbd26d04376ee826d07ec80ea267c9b9" /></metadata></package>');
assert.equal(validateReviewedMetadata('AWSSDK.S3/4.0.104', metadata, root), 'Apache-2.0');
assert.throws(() => validateReviewedMetadata('AWSSDK.S3/4.0.105', metadata, root), /requires a distribution license review/);
assert.throws(() => validateReviewedMetadata('AWSSDK.S3/4.0.104', { ...metadata, license: 'MIT' }, root), /differs from its reviewed/);
const s7Metadata = { license: null, licenseType: null, repository: 'https://github.com/killnine/s7netplus', repositoryCommit: 'f1ae0ea084e712b59e414de6aaee7d196244a239' };
assert.equal(validateReviewedMetadata('S7netplus/0.20.0', s7Metadata, root), 'MIT');
assert.throws(() => validateReviewedMetadata('S7netplus/0.20.0', { ...s7Metadata, license: 'GPL-3.0' }, root), /differs from its reviewed/);
assert.throws(() => validateReviewedMetadata('S7netplus/0.20.1', s7Metadata, root), /requires a distribution license review/);
assert.throws(() => validateReviewedMetadata('AWSSDK.S3/4.0.104', { ...metadata, repositoryCommit: '0'.repeat(40) }, root), /differs from its reviewed/);
assert.throws(() => validateReviewedMetadata('AWSSDK.S3/4.0.104', { ...metadata, repository: 'https://github.com/unreviewed/sdk' }, root), /differs from its reviewed/);
assert.throws(() => readPackageMetadata('<!DOCTYPE package [<!ENTITY key SYSTEM "file:///secret">]><package />'), /cannot contain XML entities/);
assert.equal(readPackageMetadata('<package><metadata><license type="expression">MIT &amp; BSD-2-Clause</license></metadata></package>').license, 'MIT & BSD-2-Clause');
const scribanMetadata = { licenseType: 'expression', license: 'BSD-2-Clause', repository: 'https://github.com/scriban/scriban', repositoryCommit: 'b916a431461ec8a6dcd1d6819e304726308242d3' };
assert.equal(validateReviewedMetadata('Scriban/7.5.0', scribanMetadata, root), 'BSD-2-Clause');
assert.throws(() => validateReviewedMetadata('Scriban/7.5.1', scribanMetadata, root), /requires a distribution license review/);
assert.throws(() => validateReviewedMetadata('Scriban/7.5.0', { ...scribanMetadata, license: 'MIT' }, root), /differs from its reviewed/);

fs.mkdirSync(path.join(root, '.data'), { recursive: true });
const fixture = fs.mkdtempSync(path.join(root, '.data/docker-notices-check-'));
try {
  const browserPackage = path.join(root, 'apps/web/node_modules/@ungap/structured-clone');
  const browserMetadata = JSON.parse(fs.readFileSync(path.join(browserPackage, 'package.json'), 'utf8'));
  assert.equal(validateBrowserLicense(browserMetadata, browserPackage), 'ISC', 'The exact installed Markdown dependency retains its original ISC license.');
  assert.throws(() => validateBrowserLicense({ ...browserMetadata, version: '1.4.1' }, browserPackage), /requires a distribution license review/);
  assert.throws(() => validateBrowserLicense({ ...browserMetadata, name: 'unreviewed-clone' }, browserPackage), /requires a distribution license review/);
  assert.throws(() => validateBrowserLicense({ ...browserMetadata, license: 'MIT' }, browserPackage), /requires a distribution license review/);
  assert.throws(() => validateBrowserLicense({ ...browserMetadata, license: 'GPL-3.0' }, browserPackage), /requires a distribution license review/);
  assert.equal(validateBrowserLicense({ name: 'existing-mit-fixture', version: '1.0.0', license: 'MIT' }, fixture), 'MIT');
  assert.throws(() => validateBrowserLicense(browserMetadata, fixture), /Original browser license differs/);
  fs.writeFileSync(path.join(fixture, 'LICENSE'), 'An independently authored replacement is not the reviewed original.\n');
  assert.throws(() => validateBrowserLicense(browserMetadata, fixture), /Original browser license differs/);
  if (process.platform === 'win32') {
    // Parse and invoke only the pure reviewed-spec function. Never run the
    // installer builder or require a clean checkout, compiler or privileges.
    const script = path.join(fixture, 'notice-parity.ps1');
    fs.writeFileSync(script, `param([string]$Installer)
$parseErrors = $null; $tokens = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Installer, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Installer script cannot be parsed.' }
$definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-ReviewedPackageNoticeSpec' }, $true)
if (!$definition) { throw 'Reviewed notice lookup is missing.' }
. ([ScriptBlock]::Create($definition.Extent.Text))
@{ reviewed = (Get-ReviewedPackageNoticeSpec 'Scriban/7.5.0'); unknown = (Get-ReviewedPackageNoticeSpec 'Scriban/7.5.1') } | ConvertTo-Json -Depth 8
`);
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script, path.join(root, 'tools/build-installer.ps1')], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const parity = JSON.parse(result.stdout), reviewed = reviewedSupplements.get('Scriban/7.5.0');
    assert.equal(parity.unknown, null, 'Unreviewed Scriban versions cannot inherit installer redistribution notices.');
    for (const field of ['repository', 'revision', 'license']) assert.equal(parity.reviewed[field], reviewed[field], `Windows and Docker agree on Scriban ${field}.`);
    assert.deepEqual(parity.reviewed.files.map(file => [file.name, file.sha256]), reviewed.files, 'Windows and Docker distribute the same original reviewed notice text.');
  }
  assert.throws(() => validateReviewedMetadata('BitFaster.Caching/2.6.0', { licenseType: 'file', license: 'LICENSE' }, fixture), /Original package license differs/);
  fs.writeFileSync(path.join(fixture, 'LICENSE'), 'A replacement license is not the reviewed original.\n');
  assert.throws(() => validateReviewedMetadata('BitFaster.Caching/2.6.0', { licenseType: 'file', license: 'LICENSE' }, fixture), /Original package license differs/);
  // NuGet's normalized signed-package content hash differs from its archive.
  const archive = Buffer.from('Signed package test fixture');
  const archiveHash = createHash('sha512').update(archive).digest('base64');
  const contentHash = createHash('sha512').update('Normalized package test fixture').digest('base64');
  fs.writeFileSync(path.join(fixture, '.nupkg.metadata'), JSON.stringify({ version: 2, contentHash }));
  fs.writeFileSync(path.join(fixture, 'example.1.0.0.nupkg'), archive);
  fs.writeFileSync(path.join(fixture, 'example.1.0.0.nupkg.sha512'), archiveHash);
  assert.equal(verifyNugetIntegrity(fixture, 'Example', '1.0.0', `sha512-${contentHash}`), `sha512-${archiveHash}`);
  assert.throws(() => verifyNugetIntegrity(fixture, 'Example', '1.0.0', `sha512-${archiveHash}`), /locked restored integrity/);
  fs.writeFileSync(path.join(fixture, 'example.1.0.0.nupkg'), 'Tampered package');
  assert.throws(() => verifyNugetIntegrity(fixture, 'Example', '1.0.0', `sha512-${contentHash}`), /archive integrity changed/);
  await assert.rejects(writeDockerNotices({ version: '0.2.0-preview.11', 'container-edition': '0.2.0-preview.11-docker.1', 'source-commit': '0'.repeat(40), architecture: '386' }), /supported architecture/);
  await assert.rejects(writeDockerNotices({ version: '0.2.0-preview.11', 'container-edition': '0.2.0-preview.11-docker.1', 'source-commit': '0'.repeat(40), architecture: 'amd64', 'runtime-image': 'mcr.microsoft.com/dotnet/aspnet:latest' }), /Pinned runtime base image/);
} finally {
  fs.rmSync(fixture, { recursive: true });
}
console.log('Docker notice guards: source-worker deployment and three-RID package pins, reviewed browser ISC original and unknown-license rejection, reviewed versions, license/repository changes, original-file and signed-package integrity, XML entities, architecture and immutable bases passed.');
