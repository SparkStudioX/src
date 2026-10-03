#!/usr/bin/env node
// Analyze application ASTs and enforce individually reviewed function ceilings.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { analyzeDirectory, summarize } from './analyze-web-complexity.mjs';
import { checkPolicy, csharpMetric, pythonMetric } from './complexity-policy.mjs';
import { freshDotnetEnvironment } from './dotnet-environment.mjs';

export const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
export const productionScopes = { typescript: ['apps/web/src'], csharp: ['src', 'installer/ServiceHelper'],
  python: ['runtimes/python/worker.py', 'tools/container-admin.py', 'tools/docker-entrypoint.py', 'tools/collect-docker-runtime.py'] };
const ignoredDirectory = name => ['bin', 'obj', 'node_modules', 'dist', 'wwwroot'].includes(name) || name.endsWith('.Tests');

export function csharpFiles(root) {
  function walk(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Analysis source cannot be a filesystem link: ${full}`);
      return entry.isDirectory() ? ignoredDirectory(entry.name) ? [] : walk(full)
        : entry.name.endsWith('.cs') ? [path.relative(root, full).replaceAll('\\', '/')] : [];
    });
  }
  return productionScopes.csharp.flatMap(scope => walk(path.join(root, scope))).sort();
}

export function dotnetPath(root = repositoryRoot) {
  const bundled = path.join(root, '.tools/dotnet', process.platform === 'win32' ? 'dotnet.exe' : 'dotnet');
  return process.env.SPARKSTUDIO_DOTNET || process.env.DOTNET_EXE || (fs.existsSync(bundled) ? bundled : 'dotnet');
}

export function analyzerEnvironment(executable, root = repositoryRoot) {
  const env = { ...freshDotnetEnvironment(), DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' };
  const windows = process.platform === 'win32';
  const bundled = path.join(root, '.tools/dotnet', windows ? 'dotnet.exe' : 'dotnet');
  if (path.resolve(executable) === path.resolve(bundled)) {
    const home = path.join(root, '.tools/dotnet-home');
    Object.assign(env, { DOTNET_ROOT: path.dirname(bundled), DOTNET_CLI_HOME: home,
      NUGET_PACKAGES: path.join(root, '.tools/nuget'), ...(windows ? {
        APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'),
      } : {}) });
  }
  return env;
}

function command(executable, args, cwd) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    env: analyzerEnvironment(executable) });
  if (result.error || result.status !== 0)
    throw new Error(`${path.basename(executable)} failed (${result.status ?? 'launch'}): ${result.error?.message ?? ''}\n${result.stdout ?? ''}${result.stderr ?? ''}`);
  return result.stdout;
}

export function buildAnalyzer(outDir, executable = dotnetPath()) {
  const artifacts = path.join(outDir, 'analyzer-build');
  command(executable, ['restore', path.join(repositoryRoot, 'tools/complexity/SparkStudio.Complexity.csproj'),
    '--artifacts-path', artifacts, '--configfile', path.join(repositoryRoot, 'NuGet.Config'),
    '--verbosity', 'quiet', '-p:NuGetAudit=false'], repositoryRoot);
  command(executable, ['build', path.join(repositoryRoot, 'tools/complexity/SparkStudio.Complexity.csproj'),
    '--artifacts-path', artifacts, '--no-restore', '--nologo', '--verbosity', 'quiet', '-p:NuGetAudit=false'], repositoryRoot);
  const assembly = path.join(artifacts, 'bin/SparkStudio.Complexity/debug/SparkStudio.Complexity.dll');
  if (!fs.existsSync(assembly)) throw new Error('Roslyn analyzer build did not produce its assembly.');
  return { executable, assembly };
}

export function analyzeCsharp(root, files, outDir, analyzer = buildAnalyzer(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
  const manifest = path.join(outDir, 'csharp-files.json'), output = path.join(outDir, 'csharp.json');
  fs.writeFileSync(manifest, JSON.stringify(files, null, 2) + '\n');
  if (fs.existsSync(output)) fs.unlinkSync(output);
  command(analyzer.executable, [analyzer.assembly, '--root', root, '--input', manifest, '--output', output], repositoryRoot);
  const report = JSON.parse(fs.readFileSync(output, 'utf8'));
  if (report.language !== 'csharp' || report.files.length !== files.length || !report.analyzer)
    throw new Error('Roslyn analyzer omitted source files or analyzer metadata.');
  return { ...report, metric: csharpMetric, summary: { files: report.files.length, ...summarize(report.functions) } };
}

export function pythonPath(root = repositoryRoot) {
  return process.env.SPARKSTUDIO_PYTHON || (process.platform === 'win32'
    ? path.join(root, 'runtimes/python/windows-x64/python.exe') : 'python3');
}

export function analyzePython(root, files, outDir, executable = pythonPath()) {
  fs.mkdirSync(outDir, { recursive: true });
  const manifest = path.join(outDir, 'python-files.json'), output = path.join(outDir, 'python.json');
  fs.writeFileSync(manifest, JSON.stringify(files, null, 2) + '\n');
  if (fs.existsSync(output)) fs.unlinkSync(output);
  command(executable, ['-I', path.join(repositoryRoot, 'tools/analyze-python-complexity.py'),
    '--root', root, '--input', manifest, '--output', output], repositoryRoot);
  const report = JSON.parse(fs.readFileSync(output, 'utf8'));
  if (report.language !== 'python' || report.files.length !== files.length || !report.analyzer)
    throw new Error('Python analyzer omitted source files or analyzer metadata.');
  return { ...report, metric: pythonMetric, summary: { files: report.files.length, ...summarize(report.functions) } };
}

const escape = value => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
function markdown(reports, result) {
  const functions = reports.flatMap(report => report.functions.map(item => ({ ...item, language: report.language })));
  return ['# Application cyclomatic complexity', '',
    'Each executable unit starts at 1. Count decisions in the published per-language metric; nested functions/lambdas have independent counts. All production TypeScript, C# and Python source files are listed in the JSON report with SHA-256 content hashes. Test projects and generated bin/obj/dist/wwwroot output are excluded; no production file is exempted by size or complexity.', '',
    'Policy: new functions must have complexity at most 20. Existing hotspots have individual reviewed ceilings in tools/complexity-baseline.json; increases fail. Builds never rewrite that baseline. Reductions pass and are listed so reviewers can lower the ceilings deliberately.', '',
    '| Language | Files | Functions | Decisions | Maximum | Above 20 |', '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...reports.map(report => `| ${report.language} | ${report.summary.files} | ${report.summary.functions} | ${report.summary.totalDecisions} | ${report.summary.maximum} | ${report.summary.above20} |`), '',
    `Violations: ${result.violations.length}. Reduced exceptions: ${result.reductions.length}. Removed exceptions: ${result.removedExceptions.length}.`, '',
    '## Hotspots', '', '| Complexity | Language | Function | Location |', '| ---: | --- | --- | --- |',
    ...functions.filter(item => item.complexity > 20).sort((a, b) => b.complexity - a.complexity || a.file.localeCompare(b.file)).map(item =>
      `| ${item.complexity} | ${item.language} | ${escape(item.name)} | ${item.file}:${item.line}:${item.column} |`), '',
    '## Gate violations', '', ...result.violations.map(item => `- ${item.file}:${item.line} ${escape(item.name)}: ${item.complexity} exceeds ${item.ceiling} (${item.reason}).`), '',
    '## Every analyzed file', '', '| File | Functions | Maximum |', '| --- | ---: | ---: |',
    ...reports.flatMap(report => report.files.map(file => `| ${file.file} | ${file.functions.length} | ${summarize(file.functions).maximum} |`)), ''].join('\n');
}

export function runCli(args = process.argv.slice(2)) {
  const options = { root: repositoryRoot, outDir: path.join(repositoryRoot, '.data/quality/complexity'),
    baseline: path.join(repositoryRoot, 'tools/complexity-baseline.json') };
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--help') {
      console.log('node tools/check-complexity.mjs [--root directory] [--baseline file] [--out-dir directory]');
      return;
    }
    const key = ({ '--root': 'root', '--baseline': 'baseline', '--out-dir': 'outDir' })[args[index]];
    if (!key || !args[index + 1]) throw new Error(`Unknown or incomplete option: ${args[index]}`);
    options[key] = path.resolve(args[++index]);
  }
  fs.mkdirSync(options.outDir, { recursive: true });
  for (const file of ['application.json', 'application.md']) {
    const output = path.join(options.outDir, file);
    if (fs.existsSync(output)) fs.unlinkSync(output);
  }
  const baseline = JSON.parse(fs.readFileSync(options.baseline, 'utf8'));
  const typescript = { ...analyzeDirectory(path.join(options.root, 'apps/web/src'), options.root), language: 'typescript' };
  const csharp = analyzeCsharp(options.root, csharpFiles(options.root), options.outDir);
  const python = analyzePython(options.root, productionScopes.python, options.outDir);
  const reports = [typescript, csharp, python], result = checkPolicy(reports, baseline);
  const report = { generatedAt: new Date().toISOString(), scopes: productionScopes,
    exclusions: ['*.Tests projects', 'bin', 'obj', 'node_modules', 'dist', 'wwwroot'], reports, result };
  fs.writeFileSync(path.join(options.outDir, 'application.json'), JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(path.join(options.outDir, 'application.md'), markdown(reports, result));
  for (const item of result.violations)
    console.error(`${item.file}:${item.line} ${item.name}: complexity ${item.complexity} exceeds ${item.ceiling} (${item.reason}).`);
  console.log(`Complexity: ${typescript.summary.files} frontend files / ${typescript.summary.functions} functions; ${csharp.summary.files} C# files / ${csharp.summary.functions} units; ${python.summary.files} Python files / ${python.summary.functions} units; ${result.violations.length} violations. Reports: ${options.outDir}`);
  if (result.violations.length) process.exitCode = 1;
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { runCli(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
