#!/usr/bin/env node
// Offline acceptance: dependency restore is separate; never contacts a running gateway.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const reportDir = path.join(root, '.data', 'test-results');
fs.mkdirSync(reportDir, { recursive: true });
const windows = process.platform === 'win32';
const localDotnet = path.join(root, '.tools', 'dotnet', windows ? 'dotnet.exe' : 'dotnet');
const dotnet = process.env.SPARKSTUDIO_DOTNET || (fs.existsSync(localDotnet) ? localDotnet : 'dotnet');
const python = process.env.SPARKSTUDIO_PYTHON || (windows ? path.join(root, 'runtimes/python/windows-x64/python.exe') : 'python3');
const env = { ...process.env, SPARKSTUDIO_PYTHON: python, PYTHONPYCACHEPREFIX: path.join(reportDir, 'pycache'), DOTNET_CLI_TELEMETRY_OPTOUT: '1' };
if (dotnet === localDotnet) Object.assign(env, { DOTNET_ROOT: path.dirname(localDotnet), DOTNET_CLI_HOME: path.join(root, '.tools/dotnet-home'), NUGET_PACKAGES: path.join(root, '.tools/nuget'),
  ...(windows ? { APPDATA: path.join(root, '.tools/dotnet-home/AppData/Roaming'), LOCALAPPDATA: path.join(root, '.tools/dotnet-home/AppData/Local') } : {}) });
const results = [];
function run(name, command, args, cwd = root) {
  const started = Date.now();
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 600_000, maxBuffer: 32 * 1024 * 1024 });
  const output = `${result.stdout || ''}${result.stderr || ''}${result.error ? `\n${result.error}` : ''}`;
  const log = `${String(results.length + 1).padStart(3, '0')}-${name.replace(/[^a-z0-9_.-]/gi, '-')}.log`;
  fs.writeFileSync(path.join(reportDir, log), output);
  const passed = result.status === 0 && !result.error;
  results.push({ name, passed, exitCode: result.status, seconds: (Date.now() - started) / 1000, log });
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`);
  if (!passed) console.error(output.replace(/data:text\/javascript;base64,[A-Za-z0-9+/=]+/g, '[transpiled module]').slice(-5000));
  return passed;
}
const web = path.join(root, 'apps/web');
const toolSuites = [
  'test-web-complexity',
  'test-computer-camera',
  'test-source-boundary', 'test-workshop-build', 'test-project-search', 'test-resource-changes',
  'test-bulk-replacement', 'test-authoring-assets', 'test-visual-styles', 'test-visual-styles-rendering',
  'test-localization', 'test-localization-rendering', 'test-sqlite-example', 'test-engineering-policy',
];
if (!process.argv.includes('--node-only')) {
  const artifacts = path.join(root, '.data/test-build');
  for (const name of ['Gateway', 'Connectors']) {
    const project = `src/SparkStudio.${name}.Tests`;
    if (run(`${name} build`, dotnet, ['build', project, '-c', 'Release', '--artifacts-path', artifacts, '--no-restore'])) {
      run(`${name} tests`, dotnet, [path.join(artifacts, 'bin', `SparkStudio.${name}.Tests`, 'release', `SparkStudio.${name}.Tests.dll`), '--results', path.join(reportDir, `${name.toLowerCase()}.json`), ...(name === 'Connectors' ? ['--sqlite-integration'] : [])], reportDir);
    }
  }
  run('Python worker compilation', python, ['-m', 'py_compile', path.join(root, 'runtimes/python/worker.py')]);
  run('TypeScript', process.execPath, [path.join(web, 'node_modules/typescript/bin/tsc'), '-b', '--pretty', 'false'], web);
  run('Browser build', process.execPath, [path.join(web, 'node_modules/vite/bin/vite.js'), 'build'], web);
  for (const script of ['test-backup-destinations', 'test-backup-schedule', 'test-configuration-backup'])
    run(script, process.execPath, [path.join(root, 'tools', `${script}.mjs`)], reportDir);
}
for (const script of fs.readdirSync(web).filter(file => /^check-.*\.mjs$/.test(file)).sort()) run(`web/${script}`, process.execPath, [path.join(web, script)], web);
for (const name of toolSuites) run(name, process.execPath, [path.join(root, 'tools', `${name}.mjs`)]);
const failures = results.filter(result => !result.passed).length;
fs.writeFileSync(path.join(reportDir, 'summary.json'), JSON.stringify({ version: 1, failures, suites: results }, null, 2) + '\n');
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
fs.writeFileSync(path.join(reportDir, 'junit.xml'), `<?xml version="1.0" encoding="utf-8"?>\n<testsuite name="SparkStudio offline" tests="${results.length}" failures="${failures}">${results.map(result => `<testcase name="${escape(result.name)}" time="${result.seconds}">${result.passed ? '' : `<failure message="See ${escape(result.log)}"/>`}</testcase>`).join('')}</testsuite>\n`);
console.log(`${results.length} suites; ${failures} failures. Reports: ${reportDir}`);
process.exitCode = failures ? 1 : 0;
