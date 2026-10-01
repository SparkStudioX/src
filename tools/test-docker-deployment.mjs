#!/usr/bin/env node
// Each invocation owns a fresh Compose project and volume. It never reuses gateway data.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const image = process.argv[2];
const platform = process.argv[3];
assert.ok(image && /^[a-zA-Z0-9][a-zA-Z0-9./_:@-]+$/.test(image), 'Specify the exact candidate image or published digest.');
assert.ok(['linux/amd64', 'linux/arm64'].includes(platform), 'Specify linux/amd64 or linux/arm64.');
const project = `sparkstudio-docker-test-${randomUUID().slice(0, 8)}`;
const environment = { ...process.env, SPARKSTUDIO_IMAGE: image, DOCKER_DEFAULT_PLATFORM: platform,
  SPARKSTUDIO_BIND_ADDRESS: '127.0.0.1', SPARKSTUDIO_PUBLIC_HOST: 'localhost',
  SPARKSTUDIO_HTTP_PORT: '8090', SPARKSTUDIO_HTTPS_PORT: '8443',
  SPARKSTUDIO_TLS_NAMES: 'localhost,127.0.0.1,::1', SPARKSTUDIO_COOKIE_NAMESPACE: 'SparkStudioDockerTest' };
for (const name of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) delete environment[name];
const composeArguments = ['compose', '--project-name', project, '--file', path.join(root, 'compose.yaml')];
const password = randomBytes(24).toString('base64url');
const identity = { username: 'docker-test-admin', password };
const evidence = { image, platform, hostArchitecture: null, project, testedAt: new Date().toISOString(), checks: [] };
let container, volume, ca, agent, cookies = new Map(), csrf, localContext;

function docker(arguments_, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', [...(localContext ? ['--context', localContext] : []), ...arguments_], { cwd: root, env: environment, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [], stderr = [];
    child.stdout.on('data', part => stdout.push(part));
    child.stderr.on('data', part => stderr.push(part));
    child.on('error', reject);
    child.on('close', code => {
      const result = { code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
      // Child output may contain session credentials on failure. Keep diagnostics bounded and redact.
      if (code) reject(new Error(`Docker command ${arguments_[0]} failed (${code}): ${result.stderr.replaceAll(password, '[redacted]').slice(-3000)}`));
      else resolve(result);
    });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
    child.stdin.end(input);
  });
}
const compose = (arguments_, input) => docker([...composeArguments, ...arguments_], input);
const exec = (arguments_, input) => compose(['exec', '-T', 'gateway', ...arguments_], input);
const inspect = async () => JSON.parse((await docker(['inspect', container])).stdout)[0];
async function check(name, action) {
  await action(); evidence.checks.push(name); console.log(`PASS ${platform}: ${name}`);
}

function request(route, { method = 'GET', body, headers = {}, plain = false, authenticated = false, audience = 'engineering', timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const bytes = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const sent = { ...(bytes ? { 'Content-Type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json', 'Content-Length': bytes.length } : {}),
      ...(authenticated ? { 'X-SPARK-AUDIENCE': audience, Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
        ...(method !== 'GET' && csrf ? { 'X-SPARK-CSRF': csrf } : {}) } : {}), ...headers };
    const call = (plain ? http : https).request({ hostname: '127.0.0.1', port: plain ? 8090 : 8443,
      path: route, method, headers: sent, ...(plain ? {} : { agent }), timeout }, response => {
      const parts = [];
      response.on('data', part => parts.push(part));
      response.on('end', () => {
        const data = Buffer.concat(parts);
        let json; try { json = JSON.parse(data); } catch { /* HTML and exports are deliberately binary. */ }
        resolve({ status: response.statusCode, headers: response.headers, bytes: data, json });
      });
      response.on('error', reject);
    });
    call.on('timeout', () => call.destroy(new Error('Gateway request timed out.')));
    call.on('error', reject); call.end(bytes);
  });
}
async function api(route, options = {}) {
  const response = await request(route, { authenticated: true, ...options });
  assert.equal(response.status, options.status ?? 200, `${options.method ?? 'GET'} ${route}: HTTP ${response.status}`);
  for (const cookie of response.headers['set-cookie'] ?? []) {
    const entry = cookie.split(';', 1)[0], separator = entry.indexOf('=');
    cookies.set(entry.slice(0, separator), entry.slice(separator + 1));
  }
  if (response.json?.csrfToken) csrf = response.json.csrfToken;
  return options.binary ? response.bytes : response.json;
}
const login = () => api('/api/auth/login', { method: 'POST', body: { audience: 'engineering', ...identity } });

try {
  const context = JSON.parse((await docker(['context', 'inspect'])).stdout)[0];
  assert.match(context.Endpoints.docker.Host, /^(npipe:\/\/|unix:\/\/)/, 'Use the laptop engine, never a remote Docker endpoint.');
  localContext = context.Name;
  const engine = JSON.parse((await docker(['info', '--format', '{{json .}}'])).stdout);
  assert.equal(engine.OSType, 'linux'); evidence.hostArchitecture = engine.Architecture;
  const configuration = JSON.parse((await compose(['config', '--format', 'json'])).stdout);
  const service = configuration.services.gateway;
  assert.equal(service.image, image); assert.equal(service.read_only, true); assert.equal(service.init, true);
  assert.deepEqual(service.cap_drop, ['ALL']); assert.ok(service.security_opt.includes('no-new-privileges:true'));
  assert.deepEqual(service.ports.map(port => [port.host_ip, String(port.published), port.target]), [['127.0.0.1', '8090', 8090], ['127.0.0.1', '8443', 8443]]);
  volume = configuration.volumes['sparkstudio-data'].name;
  assert.ok(volume.startsWith(`${project}_`));
  // Binding conflicts fail here. The verifier never stops another application to free ports.
  await compose(['up', '--detach', '--wait', '--wait-timeout', '180', '--pull', 'never']);
  container = (await compose(['ps', '--quiet', 'gateway'])).stdout.trim(); assert.match(container, /^[a-f0-9]{64}$/);
  const state = await inspect();
  assert.equal(state.Config.Labels['com.docker.compose.project'], project);
  assert.equal(state.Config.User, 'app'); assert.equal(state.HostConfig.ReadonlyRootfs, true);
  assert.equal(state.State.Health.Status, 'healthy');
  evidence.imageId = state.Image;
  const manifest = JSON.parse((await exec(['cat', '/app/container-manifest.json'])).stdout);
  assert.equal(manifest.platform, platform); assert.equal(manifest.containerEdition, '0.2.0-preview.11-docker.1');
  assert.equal(manifest.version, '0.2.0-preview.11'); assert.match(manifest.sourceCommit, /^[a-f0-9]{40}$/);
  assert.equal(state.Config.Labels['org.opencontainers.image.revision'], manifest.sourceCommit);
  assert.equal(state.Config.Labels['org.opencontainers.image.version'], manifest.containerEdition);
  evidence.sourceCommit = manifest.sourceCommit; evidence.containerEdition = manifest.containerEdition;
  await check('nonroot, read-only root, healthy Python and expected CPU architecture', async () => {
    assert.equal((await exec(['id', '-u'])).stdout.trim(), '1654');
    assert.equal((await exec(['uname', '-m'])).stdout.trim(), platform === 'linux/amd64' ? 'x86_64' : 'aarch64');
    assert.match((await exec(['sparkstudio-admin', 'health'])).stdout, /Python worker are ready/);
    await exec(['/usr/local/bin/python3', '-I', '-c', 'import sys,sqlite3,ssl,bz2,lzma,ctypes; assert sys.version_info[:3]==(3,14,7)']);
    assert.match((await exec(['dotnet', '--list-runtimes'])).stdout, /Microsoft.AspNetCore.App 10.0.12/);
  });
  ca = (await exec(['cat', '/data/certificates/container/server.crt'])).stdout;
  assert.ok(ca.startsWith(['-----BEGIN', 'CERTIFICATE-----'].join(' ')));
  agent = new https.Agent({ ca, rejectUnauthorized: true });
  const certificateHash = createHash('sha256').update(ca).digest('hex');
  evidence.certificateSha256 = certificateHash;
  await check('certificate-validated HTTPS and fixed-origin HTTP redirects; no public management listener', async () => {
    const session = await request('/api/auth/session?audience=engineering');
    assert.equal(session.json.setupRequired, true);
    assert.equal(session.headers['strict-transport-security'], undefined, 'Docker localhost TLS must not force parallel Windows HTTP ports onto HTTPS.');
    const redirect = await request('/runtime/example?x=1', { plain: true });
    assert.ok([307, 308].includes(redirect.status)); assert.equal(redirect.headers.location, 'https://localhost:8443/runtime/example?x=1');
    const spoof = await request('/designer/', { plain: true, headers: { Host: 'evil.invalid', 'X-Forwarded-Host': 'evil.invalid' } });
    assert.ok([400, 307, 308].includes(spoof.status));
    if (spoof.headers.location) assert.equal(new URL(spoof.headers.location).origin, 'https://localhost:8443');
    assert.equal((await request('/api/auth/login', { plain: true, method: 'POST', body: {} })).status, 403);
    assert.equal((await request('/api/ready')).status, 403);
    assert.equal((await request('/api/health')).status, 401);
    assert.equal((await request('/api/auth/setup', { method: 'POST', body: { setupCode: 'invalid', ...identity } })).status, 403);
    assert.equal(Object.keys(state.HostConfig.PortBindings).includes('5090/tcp'), false);
  });
  await check('interactive-equivalent local bootstrap, secure isolated cookie and CSRF enforcement', async () => {
    assert.match((await exec(['sparkstudio-admin', 'setup', '--stdin'], `${identity.username}\n${password}\n${password}\n`)).stdout, /Initial administrator created/);
    await assert.rejects(exec(['sparkstudio-admin', 'setup', '--stdin'], `${identity.username}\n${password}\n${password}\n`), /failed/);
    const loggedIn = await login(); assert.equal(loggedIn.user.gatewayAdmin, true); assert.ok(csrf);
    assert.ok(cookies.has('SparkStudioDockerTest.SparkStudio.Engineering'));
    const response = await request('/api/auth/login', { method: 'POST', body: { audience: 'engineering', ...identity } });
    assert.ok(response.headers['set-cookie'].some(cookie => /; secure(?:;|$)/i.test(cookie) && /; httponly(?:;|$)/i.test(cookie) && /samesite=strict/i.test(cookie)));
    assert.equal((await request('/api/projects', { method: 'POST', body: { name: 'CSRF rejected' }, headers: { 'X-SPARK-AUDIENCE': 'engineering', Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') } })).status, 403);
  });
  const tagPath = '[default]DockerWorkshop/Counter';
  let projectId, publishedAt;
  await check('persisted memory tags, native SQLite queries and Python gateway actions', async () => {
    await api('/api/tags', { method: 'POST', body: { path: tagPath, kind: 'memory', dataType: 'Int32', value: 1, enabled: true } });
    await api('/api/connections', { method: 'POST', body: { id: 'docker-sqlite', name: 'Docker SQLite fixture', type: 'sqlite', database: 'docker-test.db' } });
    assert.equal((await api('/api/connections/docker-sqlite/database', { method: 'POST', body: { initializeSampleData: true } })).success, true);
    projectId = (await api('/api/projects', { method: 'POST', body: { name: 'Docker deployment workshop' } })).id;
    const route = suffix => `/api/projects/${projectId}${suffix}`;
    await api(route('/queries/answer'), { method: 'PUT', body: { id: 'answer', name: 'SQLite answer', connectionId: 'docker-sqlite', sql: 'SELECT COUNT(*) AS records FROM production_records', kind: 'query', parameters: [] } });
    const python = await api(route('/scripts/run'), { method: 'POST', body: { code: `quality = system.tag.writeBlocking(['${tagPath}'], [42])\nresult = {'value':system.tag.readBlocking(['${tagPath}'])[0].value,'rows':system.db.runNamedQuery('answer', {}).getRowCount()}` } });
    assert.equal(python.success, true); assert.equal(python.result.value, 42); assert.equal(python.result.rows, 1);
    const draft = await api(route('/project')); delete draft.navigation; draft.templates = []; draft.parameters = {};
    draft.screens = [{ id: 'main', name: 'Docker workshop', width: 1000, height: 700, parameters: {}, components: [
      { id: 'title', type: 'label', x: 20, y: 20, width: 500, height: 50, props: { text: 'Docker gateway is running' } },
      { id: 'action', type: 'button', x: 20, y: 90, width: 300, height: 60, props: { text: 'Read counter', action: 'script', script: `result = system.tag.readBlocking(['${tagPath}'])[0].value` } },
      { id: 'records', type: 'table', x: 20, y: 170, width: 500, height: 200, props: { queryId: 'answer' } },
    ] }];
    await api(route('/project'), { method: 'PUT', body: draft });
    const review = await api(route('/project/publication-review'));
    publishedAt = (await api(route('/project/publish'), { method: 'POST', body: review })).publishedAt; assert.ok(publishedAt);
    assert.equal((await api('/api/tags/read', { method: 'POST', body: { paths: [tagPath] } }))[0].value, 42);
  });
  await check('separate operator login, published screen/query and captured Python button action', async () => {
    await api('/api/auth/login', { method: 'POST', body: { audience: 'operator', projectId, ...identity } });
    assert.ok(cookies.has('SparkStudioDockerTest.SparkStudio.Operator'));
    const route = suffix => `/api/projects/${projectId}${suffix}`;
    assert.equal((await api(route('/runtime/project'), { audience: 'operator' })).publishedAt, publishedAt);
    assert.equal((await api(route('/runtime/queries/answer/execute'), { audience: 'operator', method: 'POST', body: { publishedAt, parameters: {} } })).rows.length, 1);
    const action = await api(route('/runtime/screens/main/components/action/action'), { audience: 'operator', method: 'POST', body: { publishedAt } });
    assert.equal(action.success, true); assert.equal(action.result, 42);
    await login();
  });
  await check('portable workshop import, publication and binary export', async () => {
    const packageDirectory = path.resolve(root, process.argv[4] ?? 'artifacts/sparkproj');
    assert.ok(packageDirectory.startsWith(path.join(root, 'artifacts') + path.sep));
    const files = (await readdir(packageDirectory)).filter(name => name.endsWith('.sparkproj')).sort();
    assert.ok(files.length >= 37, 'Build the current portable workshop collection before release verification.');
    evidence.workshopCount = files.length;
    for (const filename of files) {
      const imported = await api(`/api/projects/import?name=${encodeURIComponent(`Docker ${filename}`)}`, { method: 'POST', body: await readFile(path.join(packageDirectory, filename)) });
      assert.equal(imported.published, false);
      const route = suffix => `/api/projects/${imported.id}${suffix}`;
      const review = await api(route('/project/publication-review'));
      assert.ok((await api(route('/project/publish'), { method: 'POST', body: review })).publishedAt);
      assert.ok((await api(route('/export'), { binary: true })).length > 100);
    }
  });
  await check('graceful stop and restart retain accounts, tags, database, projects, keys and TLS identity', async () => {
    const keyMetadata = (await exec(['stat', '-c', '%a %U', '/data/certificates/container/server.key'])).stdout.trim();
    assert.equal(keyMetadata, '600 app');
    // Private key hashes stay inside the container; only the equality result is returned.
    await exec(['/usr/local/bin/python3', '-I', '-c', "import hashlib,json,pathlib; p=pathlib.Path('/data'); files=[p/'certificates/container/server.key',*sorted((p/'keys').glob('*'))]; assert len(files)>1; (p/'test-key-integrity.json').write_text(json.dumps({str(f):hashlib.sha256(f.read_bytes()).hexdigest() for f in files}))"]);
    await compose(['stop', '--timeout', '45']);
    const stopped = await inspect(); assert.ok([0, 143].includes(stopped.State.ExitCode)); assert.equal(stopped.State.OOMKilled, false);
    await compose(['down']);
    await compose(['up', '--detach', '--wait', '--wait-timeout', '180', '--pull', 'never']);
    container = (await compose(['ps', '--quiet', 'gateway'])).stdout.trim();
    assert.equal(createHash('sha256').update((await exec(['cat', '/data/certificates/container/server.crt'])).stdout).digest('hex'), certificateHash);
    await exec(['/usr/local/bin/python3', '-I', '-c', "import hashlib,json,pathlib; p=pathlib.Path('/data/test-key-integrity.json'); assert all(hashlib.sha256(pathlib.Path(f).read_bytes()).hexdigest()==h for f,h in json.loads(p.read_text()).items())"]);
    assert.equal((await request('/api/health', { authenticated: true })).status, 401, 'A process restart must revoke old sessions.');
    cookies = new Map(); csrf = undefined; await login();
    assert.equal((await api('/api/tags/read', { method: 'POST', body: { paths: [tagPath] } }))[0].value, 42);
    assert.equal((await api(`/api/projects/${projectId}/project/publication`)).publishedAt, publishedAt);
    assert.equal((await api(`/api/projects/${projectId}/queries/answer/execute`, { method: 'POST', body: { parameters: {} } })).rows.length, 1);
  });
  evidence.success = true;
} finally {
  agent?.destroy();
  try {
    // Even a failed first/second up can create resources. Enumerate only our unique label.
    const ids = (await docker(['ps', '--all', '--quiet', '--filter', `label=com.docker.compose.project=${project}`])).stdout.trim().split(/\s+/).filter(Boolean);
    for (const id of ids) {
      const owned = JSON.parse((await docker(['inspect', id])).stdout)[0];
      assert.equal(owned.Config.Labels['com.docker.compose.project'], project);
    }
    const volumes = (await docker(['volume', 'ls', '--quiet', '--filter', `label=com.docker.compose.project=${project}`])).stdout.trim().split(/\s+/).filter(Boolean);
    for (const name of volumes) assert.equal(JSON.parse((await docker(['volume', 'inspect', name])).stdout)[0].Labels['com.docker.compose.project'], project);
    await compose(['down', '--volumes']);
  } finally {
    const directory = path.join(root, '.data', 'docker-release'); await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, `deployment-${platform.split('/')[1]}.json`), JSON.stringify(evidence, null, 2) + '\n');
  }
}
console.log(`Docker deployment passed ${evidence.checks.length} groups on ${platform}; test resources removed.`);
