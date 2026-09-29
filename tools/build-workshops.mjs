#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { readCatalog, buildBundleFiles, writeZip, sha256 } from './workshop-packages.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), args = process.argv.slice(2);
assert.ok(args.length === 2 && args[0] === '--version', 'Usage: node tools/build-workshops.mjs --version <bundle-version>');
const version = args[1]; assert.match(version, /^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/);
const git = (...arguments_) => execFileSync('git', arguments_, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sourceRevision = git('rev-parse', 'HEAD'), sourceDirty = Boolean(git('status', '--porcelain', '--untracked-files=normal'));
const exportedAt = process.env.SOURCE_DATE_EPOCH === undefined ? git('show', '-s', '--format=%cI', 'HEAD') : new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString();
const catalog = await readCatalog(root), { files, manifest } = await buildBundleFiles(root, catalog, { version, exportedAt, sourceRevision, sourceDirty });
const parent = path.join(root, 'artifacts', 'workshops'), destination = path.join(parent, version);
// Only authored inputs enter a fresh output folder. Existing release artifacts are never overwritten.
await fs.mkdir(parent, { recursive: true });
assert.equal((await fs.realpath(parent)).toLowerCase(), path.resolve(parent).toLowerCase(), 'Workshop output must not follow a link outside its ordinary artifacts directory.');
await fs.mkdir(destination);
try {
  for (const [name, bytes] of files) { const target = path.join(destination, name); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes, { flag: 'wx' }); }
  const bundleName = `SparkStudio-Workshops-${version}.zip`, archive = writeZip(files);
  await fs.writeFile(path.join(destination, bundleName), archive, { flag: 'wx' });
  await fs.writeFile(path.join(destination, bundleName + '.sha256'), `${sha256(archive)}  ${bundleName}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ directory: destination, bundle: bundleName, workshops: manifest.workshops.length, setupRequired: manifest.setupRequired.length, sha256: sha256(archive), sourceRevision, sourceDirty }, null, 2));
} catch (error) { throw new Error(`Workshop build failed; incomplete output retained at ${destination}. Use a new bundle version after correcting the error.`, { cause: error }); }
