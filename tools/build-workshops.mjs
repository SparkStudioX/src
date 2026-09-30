#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readCatalog, buildBundleFiles, localWorkshopFiles, writeZip, sha256 } from './workshop-packages.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), args = process.argv.slice(2);
assert.ok(args.length === 2 && args[0] === '--version', 'Usage: node tools/build-workshops.mjs --version <bundle-version>');
const version = args[1]; assert.match(version, /^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/);
const git = (...arguments_) => execFileSync('git', arguments_, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sourceRevision = git('rev-parse', 'HEAD'), sourceDirty = Boolean(git('status', '--porcelain', '--untracked-files=normal'));
const exportedAt = process.env.SOURCE_DATE_EPOCH === undefined ? git('show', '-s', '--format=%cI', 'HEAD') : new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString();
const catalog = await readCatalog(root), { files, manifest } = await buildBundleFiles(root, catalog, { version, exportedAt, sourceRevision, sourceDirty });
const parent = path.join(root, 'artifacts', 'workshops'), destination = path.join(parent, version);
const packageDirectory = path.join(root, 'artifacts', 'sparkproj'), local = localWorkshopFiles(files, manifest);
// Only authored inputs enter these folders. Release ZIPs are immutable; loose packages have one home.
await fs.mkdir(parent, { recursive: true });
assert.equal((await fs.realpath(parent)).toLowerCase(), path.resolve(parent).toLowerCase(), 'Workshop output must not follow a link outside its ordinary artifacts directory.');
await fs.mkdir(packageDirectory, { recursive: true });
assert.equal((await fs.realpath(packageDirectory)).toLowerCase(), packageDirectory.toLowerCase(), 'Package output must not follow a link outside artifacts/sparkproj.');
async function ordinaryTarget(relative) {
  let cursor = packageDirectory;
  for (const segment of relative.split('/')) {
    cursor = path.join(cursor, segment);
    try { assert.ok(!(await fs.lstat(cursor)).isSymbolicLink(), `Linked package output is not allowed: ${relative}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return cursor;
}
let previous;
try { previous = JSON.parse(await fs.readFile(await ordinaryTarget('index.json'), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
for (const [name, bytes] of local) {
  const target = await ordinaryTarget(name);
  if (!name.endsWith('.sparkproj')) continue;
  try {
    const old = await fs.readFile(target);
    assert.ok(old.equals(bytes) || previous?.packages?.some(item => item.file === name && item.sha256 === sha256(old)),
      `Refusing to replace an unindexed or locally edited package: ${target}`);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
await fs.mkdir(destination);
try {
  const bundleName = `SparkStudio-Workshops-${version}.zip`, archive = writeZip(files);
  await fs.writeFile(path.join(destination, bundleName), archive, { flag: 'wx' });
  await fs.writeFile(path.join(destination, bundleName + '.sha256'), `${sha256(archive)}  ${bundleName}\n`, { flag: 'wx' });
  await fs.writeFile(path.join(destination, 'manifest.json'), files.get('manifest.json'), { flag: 'wx' });
  await fs.writeFile(path.join(destination, 'SHA256SUMS'), files.get('SHA256SUMS'), { flag: 'wx' });
  // Publish the index last so a failed copy cannot advertise incomplete new output.
  for (const [name, bytes] of [...local].sort(([a], [b]) => Number(a === 'index.json') - Number(b === 'index.json'))) {
    const target = await ordinaryTarget(name), temporary = target + `.${randomUUID()}.tmp`;
    await fs.mkdir(path.dirname(target), { recursive: true });
    try { await fs.writeFile(temporary, bytes, { flag: 'wx' }); await fs.rename(temporary, target); }
    finally { await fs.rm(temporary, { force: true }); }
  }
  console.log(JSON.stringify({ packageDirectory, directory: destination, bundle: bundleName, workshops: manifest.workshops.length, setupRequired: manifest.setupRequired.length, sha256: sha256(archive), sourceRevision, sourceDirty }, null, 2));
} catch (error) { throw new Error(`Workshop build failed; incomplete output retained at ${destination}. Use a new bundle version after correcting the error.`, { cause: error }); }
