// Offline React checks must not recursively embed their dependency graph into
// data URLs: a shared model imported by several components otherwise expands
// exponentially. Keep each generated module in one temporary file instead.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function createTestModuleFiles() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sparkstudio-web-check-'));
  const modules = new Map();
  const files = [];
  process.once('exit', () => {
    // Remove only the exact files created by this store, then its empty folder.
    for (const file of files) { try { fs.unlinkSync(file); } catch { /* Best effort after a failed check. */ } }
    try { fs.rmdirSync(directory); } catch { /* Leave unexpected contents untouched. */ }
  });
  return source => {
    if (modules.has(source)) return modules.get(source);
    const file = path.join(directory, `module-${files.length}.mjs`);
    fs.writeFileSync(file, source, 'utf8');
    files.push(file);
    const url = pathToFileURL(file).href;
    modules.set(source, url);
    return url;
  };
}
