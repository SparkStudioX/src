#!/usr/bin/env node
// Create a disposable, independently authored SQLite read-testing project. Never runs its slow query.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const args = process.argv.slice(2);
assert.ok(args.length <= 1, 'Use an optional isolated gateway URL.');
const base = new URL(args[0] ?? 'http://127.0.0.1:5091');
assert.ok(base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname) && base.port === '5091'
  && base.pathname === '/' && !base.username && !base.password && !base.search && !base.hash,
  'Use a plain isolated loopback gateway URL on port 5091.');
const example = JSON.parse(await readFile(new URL('../examples/query-testing.json', import.meta.url), 'utf8'));
async function api(path, method = 'GET', body) {
  const response = await fetch(new URL('/api' + path, base), {
    method, headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status}. Review the gateway diagnostics.`);
  return response.json();
}
const catalog = await api('/projects');
assert.ok(!catalog.projects.some(project => project.name === example.name), 'Read query workshop already exists; open it from Projects. No changes made.');
const connections = await api('/connections');
assert.ok(!connections.some(connection => connection.id === example.connection.id
  || connection.type === 'sqlite' && connection.database === example.connection.database),
  'The reserved workshop connection or database is configured. No changes made.');
// Additive setup is not a cross-resource transaction. The gateway refuses to overwrite database files.
await api('/connections', 'POST', example.connection);
const database = await api(`/connections/${example.connection.id}/database`, 'POST', { initializeSampleData: true });
assert.ok(database.success, 'Could not create the synthetic database. Review the connection before retrying.');
const created = await api('/projects', 'POST', { name: example.name });
const route = `/projects/${encodeURIComponent(created.id)}`;
for (const query of example.queries) await api(`${route}/queries/${query.id}`, 'PUT', query);
const draft = await api(`${route}/project`);
await api(`${route}/project`, 'PUT', { ...draft, screens: example.screens, templates: example.templates, navigation: example.navigation });
console.log(`Created ${example.name} as an unpublished draft with synthetic SQLite records. The slow query was not executed.`);
console.log(`Review and explicitly publish at ${new URL(`/designer/${created.id}`, base)}`);
