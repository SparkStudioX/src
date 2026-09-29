#!/usr/bin/env node
// Offline checks create only disposable .data fixtures. --api requires the authenticated isolated gateway on 5091.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { stripTypeScriptTypes } from 'node:module';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const slow = 'WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < 500000000) SELECT SUM(n) AS total FROM sequence';
if (process.argv.includes('--api')) await apiChecks();
else { await inputChecks(); await providerChecks(); }

async function inputChecks() {
  const source = await readFile(new URL('../apps/web/src/queryTestParameters.ts', import.meta.url), 'utf8');
  const { prepareQueryTestParameters: prepare } = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`);
  const parameter = (type, value) => prepare([{ name: 'value', type, defaultValue: value }], {});
  assert.deepEqual(parameter('int', '45'), { value: '45' });
  assert.deepEqual(parameter('bigint', '9223372036854775807'), { value: '9223372036854775807' });
  assert.deepEqual(parameter('decimal', '1234567890.1234567890'), { value: '1234567890.1234567890' });
  assert.deepEqual(parameter('float', '1.5'), { value: 1.5 }); assert.deepEqual(parameter('bool', 'false'), { value: false });
  assert.deepEqual(parameter('string', ''), { value: '' }); assert.deepEqual(parameter('int', null), { value: null });
  assert.deepEqual(prepare([{ name: 'value', type: 'int', defaultValue: 5 }], { value: null }), { value: null });
  for (const [type, value] of [['int', ''], ['int', '2.4'], ['int', '2147483648'], ['bigint', '9223372036854775808'], ['float', ''], ['float', 'Infinity'], ['float', '1e400'], ['bool', 'maybe']]) assert.throws(() => parameter(type, value), /Invalid test value/);
  assert.throws(() => prepare([{ name: 'value', type: 'int' }], {}), /Enter a test value/);
  console.log('PASS Designer typed test values retain precision and reject blank, overflowing or nonfinite numeric inputs (17 cases)');
}

async function providerChecks() {
  const root = process.cwd(), directory = path.resolve('.data/test-evidence', `query-cancellation-${randomUUID()}`);
  assert.ok(directory.startsWith(path.resolve('.data') + path.sep)); await mkdir(directory, { recursive: true });
  const escape = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
  const project = path.join(directory, 'QueryCancellationCheck.csproj');
  await writeFile(project, `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup><ItemGroup><FrameworkReference Include="Microsoft.AspNetCore.App"/><ProjectReference Include="${escape(path.join(root, 'src/SparkStudio.Gateway/SparkStudio.Gateway.csproj'))}"/></ItemGroup></Project>`);
  await writeFile(path.join(directory, 'NuGet.Config'), '<configuration><packageSources><clear/></packageSources></configuration>');
  await writeFile(path.join(directory, 'Program.cs'), String.raw`
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.DataProtection;
using SparkStudio.Connectors;
using SparkStudio.Gateway;

var directory = Path.Combine(AppContext.BaseDirectory, "fixture");
var store = new ProjectStore(directory, new EphemeralDataProtectionProvider());
using var connectors = new ConnectorService(directory);
var connection = new ConnectionDefinition("cancel-check", "Disposable query checks", "sqlite", Database: "read-tests.db");
store.SaveConnection(new JsonObject { ["id"] = connection.Id, ["name"] = connection.Name, ["type"] = "sqlite", ["database"] = connection.Database });
await connectors.CreateSqliteDatabaseAsync(connection, true, default);
var bytes = SHA256.HashData(File.ReadAllBytes(Path.Combine(directory, "databases", "read-tests.db")));
var executor = new QueryExecutor(store, connectors);
var slow = Query("slow", "WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < 500000000) SELECT SUM(n) AS total FROM sequence");
var fast = Query("fast", "SELECT id, quantity FROM production_records ORDER BY id");
var clock = Stopwatch.StartNew();
await Expect<ReadQueryTimeoutException>(() => executor.ExecuteScriptDefinitionAsync(slow, null, default, 250));
Assert(clock.Elapsed < TimeSpan.FromSeconds(5), "The gateway deadline did not stop a real SQLite read promptly.");
Assert((await executor.ExecuteDefinitionAsync(fast, null, default)).Rows.Count == 3, "SQLite did not recover after deadline.");
Console.WriteLine("PASS gateway deadline interrupts real SQLite execution and the next query recovers");

clock.Restart();
using (var cancelled = new CancellationTokenSource(150)) await Expect<OperationCanceledException>(() => executor.ExecuteScriptDefinitionAsync(slow, null, cancelled.Token, 30000));
Assert(clock.Elapsed < TimeSpan.FromSeconds(5), "Caller cancellation did not interrupt SQLite promptly.");
Assert((await executor.ExecuteDefinitionAsync(fast, null, default)).Rows.Count == 3, "SQLite did not recover after cancellation.");
Console.WriteLine("PASS caller cancellation reaches SQLite's native progress handler and releases the worker");

clock.Restart();
await Task.WhenAll(Enumerable.Range(0, 6).Select(_ => Expect<ReadQueryTimeoutException>(() => executor.ExecuteScriptDefinitionAsync(slow, null, default, 300))));
Assert(clock.Elapsed < TimeSpan.FromSeconds(5), "Queued read deadlines did not cover SQLite worker waits.");
Assert((await executor.ExecuteDefinitionAsync(fast, null, default)).Rows.Count == 3, "Worker slots leaked after concurrent cancellations.");
Console.WriteLine("PASS concurrent and queued read deadlines release all SQLite worker slots");

foreach (var value in new[] { -1, 0, 249, 30001 }) await Expect<ArgumentException>(() => executor.ExecuteScriptDefinitionAsync(slow, null, default, value));
var update = Query("update", "UPDATE production_records SET quantity = 999 WHERE id = 1"); update["kind"] = "update";
foreach (var value in new[] { 0, 250, 30000 }) await Expect<ArgumentException>(() => executor.ExecuteScriptDefinitionAsync(update, null, default, value));
Assert((long)(await executor.ExecuteDefinitionAsync(fast, null, default)).Rows[0]["quantity"]! == 0, "A rejected update deadline still executed its update.");
Console.WriteLine("PASS invalid deadlines and every update deadline are rejected before database execution");

var absentSql = new ConnectionDefinition("unopened", "No SQL Server", "sqlserver", Server: "not-contacted.invalid", Database: "unused");
var absentSqlite = connection with { Database = "never-created.db" };
foreach (var provider in new[] { absentSql, absentSqlite })
{
  clock.Restart();
  try { await connectors.QueryAsync(provider, "SELECT @count", [new("count", "int", "parameter-value-canary")], default); throw new Exception("Invalid parameter was accepted."); }
  catch (ArgumentException error) { Assert(error.Message.Contains("count") && !error.Message.Contains("parameter-value-canary") && error.Message.Length < 400, "Parameter diagnostic was not bounded/redacted."); }
  Assert(clock.Elapsed < TimeSpan.FromSeconds(2), "Parameter preflight attempted to open its absent database.");
}
ConnectorService.ValidateReadParameters([new("value", "bigint", "9223372036854775807"), new("price", "decimal", "1.234567890123456789"), new("optional", "string", null)]);
await Expect<ArgumentException>(() => Task.Run(() => ConnectorService.ValidateReadParameters([new("count", "int", "2147483648")])));
await Expect<ArgumentException>(() => Task.Run(() => ConnectorService.ValidateReadParameters([new("count", "int", 1), new("@COUNT", "int", 2)])));
Console.WriteLine("PASS SQLite/SQL Server parameter contracts fail before connection and preserve exact typed values without leaking input");

using (var preCancelled = new CancellationTokenSource()) { preCancelled.Cancel(); await Expect<OperationCanceledException>(() => executor.ExecuteDefinitionAsync(fast, null, preCancelled.Token)); }
Assert(bytes.SequenceEqual(SHA256.HashData(File.ReadAllBytes(Path.Combine(directory, "databases", "read-tests.db")))), "Read tests or rejected updates changed database bytes.");
Assert(!File.Exists(Path.Combine(directory, "databases", "never-created.db")), "Preflight created an absent database.");
Console.WriteLine("PASS pre-cancellation and rejected operations preserve the disposable database byte-for-byte");
Console.WriteLine("6 real-provider query cancellation groups passed; no live SQL Server was contacted.");

JsonObject Query(string id, string sql) => new() { ["id"] = id, ["name"] = id, ["connectionId"] = connection.Id, ["kind"] = "query", ["sql"] = sql, ["parameters"] = new JsonArray() };
static void Assert(bool value, string message) { if (!value) throw new Exception(message); }
static async Task Expect<T>(Func<Task> action) where T : Exception { try { await action(); } catch (T) { return; } throw new Exception("Expected " + typeof(T).Name); }
`);
  const dotnet = path.join(root, '.tools/dotnet', process.platform === 'win32' ? 'dotnet.exe' : 'dotnet');
  const options = { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024, env: { ...process.env, DOTNET_CLI_HOME: path.join(root, '.tools/dotnet-home'), NUGET_PACKAGES: path.join(root, '.tools/nuget'), DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1' } };
  const restore = spawnSync(dotnet, ['restore', project, '--configfile', path.join(directory, 'NuGet.Config'), '-p:NuGetAudit=false', '--verbosity', 'quiet'], options);
  process.stdout.write(restore.stdout || ''); process.stderr.write(restore.stderr || ''); assert.equal(restore.status, 0, 'Query cancellation harness restore failed.');
  const result = spawnSync(dotnet, ['run', '--project', project, '--configuration', 'QueryCancellationCheck', '--no-restore', '--no-launch-profile', '--verbosity', 'quiet'], options);
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || ''); assert.equal(result.status, 0, 'Query cancellation/provider checks failed.');
}

async function apiChecks() {
  const base = new URL('http://127.0.0.1:5091');
  const suffix = randomUUID().slice(0, 8), connectionId = `cancel-${suffix}`;
  async function request(route, body, status = 200, signal) {
    const response = await fetch(new URL('/api' + route, base), { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal });
    assert.equal(response.status, status, `Unexpected status for ${route}`); return response.json();
  }
  await request('/connections', { id: connectionId, name: 'Disposable read deadline fixture', type: 'sqlite', database: `${connectionId}.db` });
  await request(`/connections/${connectionId}/database`, { initializeSampleData: true });
  const project = await request('/projects', { name: `Read cancellation ${suffix}` });
  const route = `/projects/${project.id}`;
  try {
    for (const [id, sql, kind, parameters] of [
      ['slow', slow, 'query', []], ['fast', 'SELECT id,quantity FROM production_records ORDER BY id', 'query', []],
      ['typed', 'SELECT @count AS count', 'query', [{ name: 'count', type: 'int' }]],
      ['update', 'UPDATE production_records SET quantity=999 WHERE id=1', 'update', []],
    ]) {
      const response = await fetch(new URL('/api' + route + `/queries/${id}`, base), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, name: id, connectionId, sql, kind, parameters }) }); assert.equal(response.status, 200);
    }
    const clock = performance.now(); await request(route + '/queries/slow/execute', { timeoutMs: 250 }, 504); assert.ok(performance.now() - clock < 5000);
    assert.equal((await request(route + '/queries/fast/execute', { timeoutMs: 1000 })).rows.length, 3);
    console.log('PASS HTTP504 read deadline interrupts a real SQLite query and a subsequent read recovers');
    for (const timeoutMs of [0, 249, 30001]) await request(route + '/queries/slow/execute', { timeoutMs }, 400);
    await request(route + '/queries/update/execute', { timeoutMs: 1000 }, 400);
    const bad = await request(route + '/queries/typed/execute', { parameters: { count: 'secret-value-canary' }, timeoutMs: 1000 }, 400); assert.ok(!JSON.stringify(bad).includes('secret-value-canary'));
    assert.equal((await request(route + '/queries/fast/execute', {})).rows[0].quantity, 0);
    console.log('PASS invalid/update deadlines and invalid types fail without applying a write or leaking parameter values');
    const cancellation = new AbortController(), timer = setTimeout(() => cancellation.abort(), 150);
    try { await assert.rejects(request(route + '/queries/slow/execute', { timeoutMs: 30000 }, 200, cancellation.signal), error => error.name === 'AbortError'); } finally { clearTimeout(timer); }
    assert.equal((await request(route + '/queries/fast/execute', { timeoutMs: 1000 })).rows.length, 3);
    console.log('PASS browser-style abort request rejects its result and the gateway remains responsive');
    console.log('3 query cancellation API groups passed.');
  } finally { await request(route + '/archive', { archived: true }); }
}
