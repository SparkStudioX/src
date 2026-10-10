#!/usr/bin/env node
// The Docker context is default-deny. A plugin directory missing from .dockerignore would build
// a container without that plugin, because the gateway imports plugin targets only when they exist.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const rules = new Set(fs.readFileSync(path.join(root, '.dockerignore'), 'utf8').split(/\r?\n/).map(line => line.trim()));
const required = ['!plugins/', '!plugins/*/', '!plugins/*/*.targets', '!plugins/*/*.md', '!plugins/*/*/', '!plugins/*/*/*.cs', '!plugins/*/*/*.csproj'];
for (const rule of required) assert.ok(rules.has(rule), `.dockerignore must allow ${rule}`);

const plugins = path.join(root, 'plugins');
let projects = 0;
for (const plugin of fs.existsSync(plugins) ? fs.readdirSync(plugins, { withFileTypes: true }).filter(entry => entry.isDirectory()) : []) {
  for (const entry of fs.readdirSync(path.join(plugins, plugin.name), { withFileTypes: true })) {
    if (entry.isFile()) {
      assert.match(entry.name, /\.(?:targets|md)$/, `plugins/${plugin.name}/${entry.name} is outside the Docker context allowlist`);
      continue;
    }
    for (const file of fs.readdirSync(path.join(plugins, plugin.name, entry.name), { withFileTypes: true })) {
      if (file.isDirectory() && ['bin', 'obj'].includes(file.name)) continue; // build output; excluded by **/bin and **/obj
      assert.ok(file.isFile(), `plugins/${plugin.name}/${entry.name}/${file.name} is nested deeper than the Docker context allowlist`);
      assert.match(file.name, /\.(?:cs|csproj)$/, `plugins/${plugin.name}/${entry.name}/${file.name} is outside the Docker context allowlist`);
      if (file.name.endsWith('.csproj')) projects++;
    }
  }
}
console.log(`Docker context allowlist covers ${projects} plugin project(s).`);
