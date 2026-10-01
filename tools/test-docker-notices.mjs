#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readPackageMetadata, validateReviewedMetadata, verifyNugetIntegrity, writeDockerNotices } from './write-docker-notices.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const metadata = readPackageMetadata('<package><metadata><id>AWSSDK.S3</id><version>4.0.104</version><license type="expression">Apache-2.0</license><repository url="https://github.com/aws/aws-sdk-net" commit="f5257515bbd26d04376ee826d07ec80ea267c9b9" /></metadata></package>');
assert.equal(validateReviewedMetadata('AWSSDK.S3/4.0.104', metadata, root), 'Apache-2.0');
assert.throws(() => validateReviewedMetadata('AWSSDK.S3/4.0.105', metadata, root), /requires a distribution license review/);
assert.throws(() => validateReviewedMetadata('AWSSDK.S3/4.0.104', { ...metadata, license: 'MIT' }, root), /differs from its reviewed/);
assert.throws(() => validateReviewedMetadata('AWSSDK.S3/4.0.104', { ...metadata, repositoryCommit: '0'.repeat(40) }, root), /differs from its reviewed/);
assert.throws(() => validateReviewedMetadata('AWSSDK.S3/4.0.104', { ...metadata, repository: 'https://github.com/unreviewed/sdk' }, root), /differs from its reviewed/);
assert.throws(() => readPackageMetadata('<!DOCTYPE package [<!ENTITY key SYSTEM "file:///secret">]><package />'), /cannot contain XML entities/);
assert.equal(readPackageMetadata('<package><metadata><license type="expression">MIT &amp; BSD-2-Clause</license></metadata></package>').license, 'MIT & BSD-2-Clause');

fs.mkdirSync(path.join(root, '.data'), { recursive: true });
const fixture = fs.mkdtempSync(path.join(root, '.data/docker-notices-check-'));
try {
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
console.log('Docker notice guards: reviewed versions, license/repository changes, original-file and signed-package integrity, XML entities, architecture and immutable bases passed.');
