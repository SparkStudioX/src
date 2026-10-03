#!/usr/bin/env node
// Each invocation owns a fresh Compose project and volume. It never reuses gateway data.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFile, readdir, realpath, mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readZip, sha256 } from './workshop-packages.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
// Keep image, platform and optional workshop directory/ZIP positional for existing release commands.
// Host ports can differ from Compose's fixed internal ports when another gateway is running.
function deploymentOptions(arguments_) {
  const [image, platform, ...remaining] = arguments_;
  assert.ok(image && /^[a-zA-Z0-9][a-zA-Z0-9./_:@-]+$/.test(image), 'Specify the exact candidate image or published digest.');
  assert.ok(['linux/amd64', 'linux/arm64'].includes(platform), 'Specify linux/amd64 or linux/arm64.');
  const options = { image, platform, workshopDirectory: 'artifacts/sparkproj', httpPort: '8090', httpsPort: '8443' };
  const flags = new Map([['--http-port', 'httpPort'], ['--https-port', 'httpsPort'], ['--expected-source-commit', 'expectedSourceCommit']]);
  const seen = new Set();
  while (remaining.length) {
    const argument = remaining.shift();
    const name = flags.get(argument);
    if (name) {
      assert.ok(!seen.has(name) && remaining[0] && !remaining[0].startsWith('--'), `Provide ${argument} once, followed by its value.`);
      seen.add(name); options[name] = remaining.shift();
    } else {
      assert.ok(!argument.startsWith('--') && !seen.has('workshopDirectory'), `Unknown or repeated argument: ${argument}`);
      seen.add('workshopDirectory'); options.workshopDirectory = argument;
    }
  }
  for (const name of ['httpPort', 'httpsPort']) {
    assert.ok(/^[1-9]\d{3,4}$/.test(options[name]) && Number(options[name]) >= 1024 && Number(options[name]) <= 65535,
      `${name} must be an integer host port from 1024 to 65535.`);
  }
  assert.notEqual(options.httpPort, options.httpsPort, 'HTTP and HTTPS host ports must differ.');
  if (options.expectedSourceCommit !== undefined) assert.match(options.expectedSourceCommit, /^[a-f0-9]{40}$/, 'Expected source commit must be a full lowercase SHA-1.');
  return options;
}
function sourceCommit(explicit) {
  if (explicit) return explicit;
  const git = (...arguments_) => execFileSync('git', arguments_, { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  assert.equal(git('status', '--porcelain', '--untracked-files=all'), '', 'Verify a clean checkout, or provide --expected-source-commit for a previously built image.');
  const revision = git('rev-parse', 'HEAD');
  assert.match(revision, /^[a-f0-9]{40}$/);
  return revision;
}
async function expectedRelease() {
  const [gateway, composeSource] = await Promise.all([
    readFile(path.join(root, 'src/SparkStudio.Gateway/SparkStudio.Gateway.csproj'), 'utf8'), readFile(path.join(root, 'compose.yaml'), 'utf8'),
  ]);
  const version = gateway.match(/<Version>([^<]+)<\/Version>/)?.[1];
  const containerEdition = composeSource.match(/image: \$\{SPARKSTUDIO_IMAGE:-ladder99\/sparkstudio:([^}]+)\}/)?.[1];
  assert.match(version ?? '', /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/, 'Gateway project must declare a release version.');
  assert.ok(containerEdition?.startsWith(`${version}-docker.`) && /^\d+$/.test(containerEdition.slice(version.length + 8)), 'Compose Docker edition must match the gateway product version.');
  return { version, containerEdition };
}
const options = deploymentOptions(process.argv.slice(2));
const { image, platform, httpPort, httpsPort } = options;
const expectedSourceCommit = sourceCommit(options.expectedSourceCommit);
const expected = await expectedRelease();
const project = `sparkstudio-docker-test-${randomUUID().slice(0, 8)}`;
const environment = { ...process.env, SPARKSTUDIO_IMAGE: image, DOCKER_DEFAULT_PLATFORM: platform,
  SPARKSTUDIO_BIND_ADDRESS: '127.0.0.1', SPARKSTUDIO_PUBLIC_HOST: 'localhost',
  SPARKSTUDIO_HTTP_PORT: httpPort, SPARKSTUDIO_HTTPS_PORT: httpsPort,
  SPARKSTUDIO_TLS_NAMES: 'localhost,127.0.0.1,::1', SPARKSTUDIO_COOKIE_NAMESPACE: 'SparkStudioDockerTest' };
for (const name of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) delete environment[name];
const composeArguments = ['compose', '--project-name', project, '--file', path.join(root, 'compose.yaml')];
const password = randomBytes(24).toString('base64url');
const identity = { username: 'docker-test-admin', password };
const evidence = { image, platform, expectedVersion: expected.version, expectedContainerEdition: expected.containerEdition, expectedSourceCommit,
  httpPort: Number(httpPort), httpsPort: Number(httpsPort), hostArchitecture: null, project, testedAt: new Date().toISOString(), checks: [] };
let container, volume, ca, agent, cookies = new Map(), csrf, localContext;

async function workshopPackages() {
  const artifactRoot = await realpath(path.join(root, 'artifacts'));
  const input = await realpath(path.resolve(root, options.workshopDirectory));
  assert.ok(input.startsWith(artifactRoot + path.sep), 'Workshop packages must be inside this checkout artifacts directory.');
  const zipInput = path.extname(input).toLowerCase() === '.zip';
  const directory = zipInput ? path.dirname(input) : input;
  const files = await readdir(directory);
  if (files.includes('manifest.json')) {
    // Reuse the full frozen-bundle hash verifier; never substitute current loose packages.
    execFileSync(process.execPath, [path.join(root, 'tools/test-workshop-packages.mjs'), directory, '--verify-only'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
    assert.equal(manifest.version, expected.version, 'Frozen workshops must match the product version.');
    const bundlePath = path.join(directory, `SparkStudio-Workshops-${manifest.version}.zip`);
    if (zipInput) assert.equal(input, await realpath(bundlePath), 'Choose the ZIP named by the frozen workshop manifest.');
    const archiveBytes = await readFile(bundlePath);
    const archive = readZip(archiveBytes);
    evidence.workshopBundle = { version: manifest.version, sha256: sha256(archiveBytes), sourceRevision: manifest.sourceRevision };
    return manifest.workshops.map(workshop => ({ filename: path.basename(workshop.package.path), bytes: archive.get(workshop.package.path) }));
  }
  assert.equal(zipInput, false, 'A frozen workshop ZIP requires its manifest and checksum sidecars.');
  return Promise.all(files.filter(name => name.endsWith('.sparkproj')).sort().map(async filename => {
    const file = await realpath(path.join(directory, filename));
    assert.ok(file.startsWith(directory + path.sep), 'Workshop packages must not resolve outside their directory.');
    return { filename, bytes: await readFile(file) };
  }));
}
const packages = await workshopPackages();
assert.ok(packages.length >= 37, 'Build the current portable workshop collection before release verification.');

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
    const call = (plain ? http : https).request({ hostname: '127.0.0.1', port: plain ? Number(httpPort) : Number(httpsPort),
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

async function verifyCurrentConfiguration() {
  assert.equal((await api('/api/health')).version, `${expected.version}+${expectedSourceCommit}`);
  const settings = await api('/api/gateway/ai');
  assert.equal(settings.enabled, false); assert.equal(settings.hasApiKey, false);
  assert.equal(settings.model, 'gemini-3.8-flash'); assert.equal(settings.modelStepLimit, 100);
  assert.equal(settings.loggingEnabled, true); assert.equal(settings.parallelLimit, 4);
  assert.equal(Object.hasOwn(settings, 'apiKey'), false);
  const status = await api('/api/ask-spark/status');
  assert.equal(status.configured, false); assert.equal(status.enabled, false);
  const usage = await api('/api/gateway/ai/usage');
  for (const name of ['limit', 'usedTokens', 'cachedTokens', 'totalTokens', 'requests', 'uncertainRequests', 'inputTokens', 'outputTokens', 'thoughtTokens', 'unclassifiedTokens'])
    assert.equal(usage[name], 0, `Fresh AI usage ${name} must be zero.`);
  assert.ok(Number.isFinite(Date.parse(usage.resetsAt)));
  evidence.askSpark = { model: settings.model, modelStepLimit: settings.modelStepLimit, loggingEnabled: settings.loggingEnabled,
    hasApiKey: settings.hasApiKey, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, thoughtTokens: usage.thoughtTokens, providerRequestsMade: false };

  // Validate saved HTTP source contracts without contacting external devices.
  for (const type of ['mtconnect', 'i3x']) {
    const saved = await api('/api/connections', { method: 'POST', body: { id: `docker-${type}`, name: `Docker ${type} fixture`, type, enabled: false,
      source: { endpoint: 'http://127.0.0.1:1', acquisition: 'poll', points: [], authentication: { mode: 'none' } } } });
    assert.equal(saved.type, type); assert.equal(saved.enabled, false); assert.deepEqual(saved.source.points, []);
  }
  // No broker is needed for a mapping preview. Script warm-up must fail closed in
  // the ordinary unprivileged Compose container, while scalar decoding still works.
  const mapping = { id: 'extraction', topicFilter: 'docker/value', root: '[default]DockerSource', tags: 'review', payload: 'script', script: 'json(payload).value', dataType: 'Int32' };
  const mqtt = await api('/api/connections', { method: 'POST', body: { id: 'docker-mqtt', name: 'Docker MQTT fixture', type: 'mqtt', enabled: true,
    source: { endpoint: 'mqtt://127.0.0.1:1', acquisition: 'subscribe', points: [], mqtt: { mappings: [mapping] } } } });
  const route = '/api/connections/docker-mqtt/source';
  const capabilities = (await api(route + '/test', { method: 'POST', body: { revision: mqtt.revision } })).capabilities;
  assert.equal(capabilities.driver, 'mqtt'); assert.equal(capabilities.canWrite, false);
  assert.deepEqual(capabilities.acquisitionModes, ['subscribe']);
  assert.ok(capabilities.supportedRepresentations.includes('scalar') && capabilities.supportedRepresentations.includes('script'));
  const body = { revision: mqtt.revision, mappingId: mapping.id, topic: 'docker/value', payload: '42', mapping: { ...mapping, payload: 'scalar', script: null } };
  const scalar = await api(route + '/script/test', { method: 'POST', body });
  assert.equal(scalar.success, true); assert.equal(scalar.skip, false);
  assert.equal(scalar.discoveries.length, 1); assert.equal(scalar.discoveries[0].value, 42);
  const expression = await api(route + '/script/test', { method: 'POST', body: { ...body, payload: '{"value":42}', mapping } });
  assert.equal(expression.success, false); assert.match(expression.error, /Scripting is disabled: delegate a cgroup-v2 memory controller/);
  evidence.sources = { configured: ['mtconnect', 'i3x', 'mqtt'], mqttCapabilities: capabilities, scalarPreview: true,
    expressionSandboxAvailable: false, expressionSandboxReason: expression.error, liveSourceServersTested: false };
  await api('/api/connections', { method: 'POST', body: { ...mqtt, enabled: false } });
}

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
  assert.deepEqual(service.ports.map(port => [port.host_ip, String(port.published), port.target]), [['127.0.0.1', httpPort, 8090], ['127.0.0.1', httpsPort, 8443]]);
  assert.equal(service.environment.SPARKSTUDIO_HTTPS_PORT, httpsPort);
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
  assert.equal(manifest.product, 'SparkStudio'); assert.equal(manifest.platform, platform);
  assert.equal(manifest.containerEdition, expected.containerEdition); assert.equal(manifest.version, expected.version);
  assert.equal(manifest.sourceCommit, expectedSourceCommit, 'Image source revision differs from the expected reviewed commit.');
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
    assert.ok([307, 308].includes(redirect.status)); assert.equal(redirect.headers.location, `https://localhost:${httpsPort}/runtime/example?x=1`);
    const spoof = await request('/designer/', { plain: true, headers: { Host: 'evil.invalid', 'X-Forwarded-Host': 'evil.invalid' } });
    assert.ok([400, 307, 308].includes(spoof.status));
    if (spoof.headers.location) assert.equal(new URL(spoof.headers.location).origin, `https://localhost:${httpsPort}`);
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
  await check('current AI defaults and usage, source configuration and fail-closed expression sandbox', verifyCurrentConfiguration);
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
    evidence.workshopCount = packages.length;
    for (const { filename, bytes } of packages) {
      const imported = await api(`/api/projects/import?name=${encodeURIComponent(`Docker ${filename}`)}`, { method: 'POST', body: bytes });
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
