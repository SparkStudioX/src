import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test, before } from 'node:test';
import { analyzeSource, metric as typescriptMetric } from './analyze-web-complexity.mjs';
import { analyzeCsharp, analyzePython, analyzerEnvironment, buildAnalyzer, csharpFiles, dotnetPath,
  productionScopes, repositoryRoot } from './check-complexity.mjs';
import { csharpMetric, pythonMetric, checkPolicy } from './complexity-policy.mjs';

const scratch = path.join(repositoryRoot, '.data/quality/complexity-tests', String(process.pid));
let analyzer;
before(() => { fs.mkdirSync(scratch, { recursive: true }); analyzer = buildAnalyzer(scratch); });

const baselineFor = exceptions => ({ version: 1, maximumNewComplexity: 20,
  metrics: { typescript: typescriptMetric, csharp: csharpMetric, python: pythonMetric }, exceptions });
const fixtureRoot = name => {
  const root = path.join(scratch, name);
  for (const folder of ['apps/web/src', 'src', 'installer/ServiceHelper']) fs.mkdirSync(path.join(root, folder), { recursive: true });
  for (const file of productionScopes.python) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), 'def safe(value):\n    return value\n');
  }
  return root;
};
const decisions = count => Array.from({ length: count }, (_, index) => `if (value == ${index}) value++;`).join('\n');
const csharpFunction = count => `class Branches { int Existing(int value) { ${decisions(count)} return value; } }`;
const typescriptFunction = count => `function existing(value: number) { ${decisions(count)} return value; }`;
const pythonFunction = count => `def existing(value):\n${Array.from({ length: count }, (_, index) =>
  `    if value == ${index}:\n        value += 1\n`).join('')}    return value\n`;

test('SDK selection honors the build coordinator and isolates the bundled Windows profile', () => {
  const previous = process.env.SPARKSTUDIO_DOTNET;
  try {
    process.env.SPARKSTUDIO_DOTNET = 'configured-sdk';
    assert.equal(dotnetPath(), 'configured-sdk');
  } finally {
    if (previous === undefined) delete process.env.SPARKSTUDIO_DOTNET;
    else process.env.SPARKSTUDIO_DOTNET = previous;
  }
  const bundled = path.join(repositoryRoot, '.tools/dotnet', process.platform === 'win32' ? 'dotnet.exe' : 'dotnet');
  const env = analyzerEnvironment(bundled);
  assert.equal(env.DOTNET_ROOT, path.dirname(bundled));
  assert.equal(env.DOTNET_CLI_HOME, path.join(repositoryRoot, '.tools/dotnet-home'));
  assert.equal(env.NUGET_PACKAGES, path.join(repositoryRoot, '.tools/nuget'));
  if (process.platform === 'win32') {
    assert.equal(env.APPDATA, path.join(repositoryRoot, '.tools/dotnet-home/AppData/Roaming'));
    assert.equal(env.LOCALAPPDATA, path.join(repositoryRoot, '.tools/dotnet-home/AppData/Local'));
  }
});

test('Roslyn counts C# decisions, nested units, accessors, primary constructors and every conditional branch', () => {
  const root = fixtureRoot('roslyn-metric');
  fs.writeFileSync(path.join(root, 'src/Fixture.cs'), `
using System;
int top = args.Length > 0 ? 1 : 0;
class Controller(int seed) {
  private readonly int initial = seed > 0 ? seed : 0;
  public int Ready => initial > 0 ? 1 : 0;
  public int Decisions(int value, int? fallback) {
    if (value > 0 && value < 2 || value < 0) value++;
    for (int i = 0; i < 2; i++) value++;
    foreach (var item in new[] { 1 }) value++;
    while (value < 0) value++;
    do { value++; } while (value < 0);
    try { value++; } catch (Exception) { value++; }
    switch (value) { case 1: break; case 2: break; default: break; }
    return fallback ?? (value > 0 ? value : 0);
  }
  public int Outer(int value) {
    int Local(int item) { if (item > 0) return item; return 0; }
    Func<int, int> transform = item => { if (item > 0) return item; return 0; };
    return Local(transform(value));
  }
#if FEATURE
  public int Conditional(int value) { if (value > 0) return value; if (value < 0) return 0; return 1; }
#else
  public int Conditional(int value) => value;
#endif
}
`);
  const report = analyzeCsharp(root, ['src/Fixture.cs'], path.join(root, 'report'), analyzer);
  const find = name => report.functions.find(item => item.name.endsWith(name));
  assert.equal(find('<top-level>').complexity, 2);
  assert.equal(find('primary constructor(int)').complexity, 2);
  assert.equal(find('Ready.get').complexity, 2);
  assert.equal(find('Decisions(int,int?)').complexity, 13);
  assert.equal(find('Outer(int)').complexity, 1, 'nested branches cannot inflate parent counts');
  assert.equal(find('Local(int)').complexity, 2);
  assert.equal(find('lambda:transform').complexity, 2);
  assert.equal(find('Conditional(int)').complexity, 3, 'worst preprocessor branch must be measured');
  assert.equal(report.functions.length, 8);
  assert.equal(report.files[0].sha256.length, 64);
  assert.ok(report.functions.every(item => item.line > 0 && item.endLine >= item.line));
});

test('Python AST counts decisions, comprehensions, match guards and independent nested functions/lambdas', () => {
  const root = fixtureRoot('python-metric');
  fs.writeFileSync(path.join(root, 'runtimes/python/worker.py'), `
def decisions(value, other):
    if value and other or value:
        value += 1
    for item in []:
        value += 1
    while value < 0:
        value += 1
    try:
        value += 1
    except ValueError:
        value += 1
    assert value >= 0
    values = [item for item in [] if item > 0]
    match value:
        case 1 | 2 if other:
            pass
        case _:
            pass
    return value if 0 < value < 5 else other

def outer(value):
    def inner(item):
        if item:
            return item
        return 0
    transform = lambda item: item if item else 0
    return inner(transform(value))

class Controller:
    if True:
        ready = True

    async def read(self, values):
        async for value in values:
            if value:
                return value
        return 0
`);
  const report = analyzePython(root, ['runtimes/python/worker.py'], path.join(root, 'report'));
  const find = name => report.functions.find(item => item.name === name);
  assert.equal(find('<module>').complexity, 2, 'class declaration bodies execute in their containing unit');
  assert.equal(find('decisions').complexity, 15);
  assert.equal(find('outer').complexity, 1);
  assert.equal(find('outer / inner').complexity, 2);
  assert.equal(find('outer / lambda:transform').complexity, 2);
  assert.equal(find('Controller / read').complexity, 3);
  assert.equal(report.functions.length, 6);
  assert.equal(report.files[0].sha256.length, 64);
});

test('actual gate CLI fails increases, new named/lambda hotspots and parse errors; reductions pass without rewriting baseline', () => {
  const root = fixtureRoot('cli-policy'), outDir = path.join(root, 'report');
  const tsFile = path.join(root, 'apps/web/src/fixture.ts'), csFile = path.join(root, 'src/Fixture.cs');
  fs.writeFileSync(tsFile, typescriptFunction(20));
  fs.writeFileSync(csFile, csharpFunction(20));
  const pyFile = path.join(root, 'runtimes/python/worker.py');
  fs.writeFileSync(pyFile, pythonFunction(20));
  const cs = analyzeCsharp(root, ['src/Fixture.cs'], path.join(root, 'initial'), analyzer);
  const ts = analyzeSource('apps/web/src/fixture.ts', fs.readFileSync(tsFile, 'utf8'));
  const py = analyzePython(root, ['runtimes/python/worker.py'], path.join(root, 'initial'));
  const exceptions = [{ ...ts.functions[0], language: 'typescript' }, { ...cs.functions[0], language: 'csharp' },
    { ...py.functions.find(item => item.name === 'existing'), language: 'python' }]
    .map(({ language, file, name, occurrence, complexity }) => ({ language, file, name, occurrence, ceiling: complexity }));
  const baselineFile = path.join(root, 'baseline.json');
  const baselineText = JSON.stringify(baselineFor(exceptions), null, 2) + '\n';
  fs.writeFileSync(baselineFile, baselineText);
  const invoke = () => spawnSync(process.execPath, [path.join(repositoryRoot, 'tools/check-complexity.mjs'),
    '--root', root, '--baseline', baselineFile, '--out-dir', outDir], { cwd: repositoryRoot, encoding: 'utf8', timeout: 120000 });
  let result = invoke();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const [file, original, higher] of [[tsFile, typescriptFunction(20), typescriptFunction(21)],
    [csFile, csharpFunction(20), csharpFunction(21)], [pyFile, pythonFunction(20), pythonFunction(21)]]) {
    fs.writeFileSync(file, higher);
    result = invoke();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /existing hotspot increased/);
    fs.writeFileSync(file, original);
  }
  fs.writeFileSync(tsFile, typescriptFunction(20) + `\nconst added = (value: number) => { ${decisions(20)} return value; };`);
  result = invoke();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /new hotspot/);
  fs.writeFileSync(tsFile, typescriptFunction(20));
  fs.writeFileSync(csFile, csharpFunction(20) + `\nclass Added { Func<int,int> Field = value => { ${decisions(20)} return value; }; }`);
  result = invoke();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /new hotspot/);
  fs.writeFileSync(csFile, csharpFunction(20));
  fs.writeFileSync(pyFile, pythonFunction(20) + '\n' + pythonFunction(20).replace('def existing(', 'def added('));
  result = invoke();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /new hotspot/);
  fs.writeFileSync(tsFile, typescriptFunction(19));
  fs.writeFileSync(csFile, csharpFunction(19));
  fs.writeFileSync(pyFile, pythonFunction(19));
  result = invoke();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.readFileSync(baselineFile, 'utf8'), baselineText, 'checking must never replace reviewed ceilings');
  const report = JSON.parse(fs.readFileSync(path.join(outDir, 'application.json'), 'utf8'));
  assert.equal(report.result.reductions.length, 3);
  for (const [file, broken, restored] of [[tsFile, 'function broken(', typescriptFunction(19)],
    [csFile, '#if FEATURE\nclass Broken { int Method(\n#endif', csharpFunction(19)],
    [pyFile, 'def broken(:\n    pass', pythonFunction(19)]]) {
    fs.writeFileSync(file, broken);
    result = invoke();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /fixture\.ts|Fixture\.cs|worker\.py/);
    fs.writeFileSync(file, restored);
  }
});

test('real application source passes the reviewed baseline and includes all production C# projects', () => {
  const result = spawnSync(process.execPath, [path.join(repositoryRoot, 'tools/check-complexity.mjs'),
    '--out-dir', path.join(scratch, 'application')], { cwd: repositoryRoot, encoding: 'utf8', timeout: 120000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(fs.readFileSync(path.join(scratch, 'application/application.json'), 'utf8'));
  const backend = report.reports.find(item => item.language === 'csharp');
  for (const scope of ['src/SparkStudio.Gateway/', 'src/SparkStudio.Connectors/', 'src/SparkStudio.SourceWorker/', 'installer/ServiceHelper/'])
    assert.ok(backend.files.some(file => file.file.startsWith(scope)), scope);
  assert.ok(backend.functions.some(item => item.file === 'src/SparkStudio.Gateway/Program.cs' && item.name === '<top-level>'));
  assert.ok(backend.functions.some(item => item.name.includes('callback:app.Use')));
  assert.equal(backend.files.length, csharpFiles(repositoryRoot).length);
  assert.equal(report.result.violations.length, 0);
  const frontend = report.reports.find(item => item.language === 'typescript');
  assert.ok(frontend.functions.some(item => item.name.includes('jsx:onClick')));
  const python = report.reports.find(item => item.language === 'python');
  assert.deepEqual(python.files.map(file => file.file), productionScopes.python);
  assert.ok(python.functions.some(item => item.file === 'runtimes/python/worker.py' && item.name !== '<module>'));
});

test('malformed or duplicate baselines fail closed', () => {
  const item = { file: 'file', name: 'method', occurrence: 1, complexity: 21 };
  const reports = [typescriptMetric, csharpMetric, pythonMetric].map((metric, index) => ({
    language: ['typescript', 'csharp', 'python'][index], metric, files: [{ file: 'file' }], functions: [item],
  }));
  const exception = { ...item, language: 'csharp', ceiling: 21 };
  assert.throws(() => checkPolicy(reports, baselineFor([exception, exception])), /Duplicate/);
  assert.throws(() => checkPolicy(reports, { ...baselineFor([]), maximumNewComplexity: 999 }), /threshold is 20/);
  assert.throws(() => checkPolicy(reports.slice(0, 2), baselineFor([])), /All three application languages/);
});
