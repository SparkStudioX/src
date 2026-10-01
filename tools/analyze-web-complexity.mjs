#!/usr/bin/env node
// Authored static analysis: TypeScript AST, no application execution or network access.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const ts = require('typescript');
export const metric = {
  name: 'McCabe cyclomatic complexity (syntax-based)',
  version: 1,
  base: 1,
  decisions: ['if', 'for', 'for-in', 'for-of', 'while', 'do-while', 'catch', 'conditional expression', 'non-default switch case', '&&', '||', '??'],
  exclusions: ['nested function bodies (reported separately)', 'optional chaining', 'else', 'default switch clauses', 'logical assignment operators', 'type syntax'],
};

function isFunction(node) {
  return (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node) || ts.isConstructorDeclaration(node)) && Boolean(node.body);
}

function localName(node, source) {
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  if (node.name) return node.name.getText(source);
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) return parent.name.getText(source);
  if (ts.isBinaryExpression(parent) && parent.right === node) return parent.left.getText(source);
  if (ts.isJsxExpression(parent) && ts.isJsxAttribute(parent.parent)) return `jsx:${parent.parent.name.getText(source)}`;
  if (ts.isCallExpression(parent)) return `callback:${parent.expression.getText(source).replace(/\s+/g, ' ').slice(0, 80)}`;
  return '<anonymous>';
}

function decisionKind(node) {
  switch (node.kind) {
    case ts.SyntaxKind.IfStatement: return 'if';
    case ts.SyntaxKind.ForStatement: return 'for';
    case ts.SyntaxKind.ForInStatement: return 'for-in';
    case ts.SyntaxKind.ForOfStatement: return 'for-of';
    case ts.SyntaxKind.WhileStatement: return 'while';
    case ts.SyntaxKind.DoStatement: return 'do-while';
    case ts.SyntaxKind.CatchClause: return 'catch';
    case ts.SyntaxKind.ConditionalExpression: return 'conditional expression';
    case ts.SyntaxKind.CaseClause: return 'non-default switch case';
    case ts.SyntaxKind.BinaryExpression:
      return ({ [ts.SyntaxKind.AmpersandAmpersandToken]: '&&', [ts.SyntaxKind.BarBarToken]: '||', [ts.SyntaxKind.QuestionQuestionToken]: '??' })[node.operatorToken.kind];
    default: return undefined;
  }
}

function countFunction(node) {
  const decisions = {};
  function visit(child) {
    if (child !== node && isFunction(child)) return;
    const kind = decisionKind(child);
    if (kind) decisions[kind] = (decisions[kind] || 0) + 1;
    ts.forEachChild(child, visit);
  }
  visit(node);
  return { complexity: 1 + Object.values(decisions).reduce((sum, count) => sum + count, 0), decisions };
}

/** Every executable function is a separate unit, including inline JSX callbacks. */
export function analyzeSource(file, text) {
  const scriptKind = /\.tsx$/i.test(file) ? ts.ScriptKind.TSX : /\.jsx$/i.test(file) ? ts.ScriptKind.JSX
    : /\.(?:[cm]?js)$/i.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind);
  if (source.parseDiagnostics.length) throw new Error(`${file}: ${source.parseDiagnostics.map(item => ts.flattenDiagnosticMessageText(item.messageText, '\n')).join('; ')}`);
  const functions = [], occurrences = new Map();
  function visit(node, scope = []) {
    let childrenScope = scope;
    if ((ts.isClassDeclaration(node) || ts.isClassExpression(node)) && node.name) childrenScope = [...scope, node.name.getText(source)];
    if (isFunction(node)) {
      const name = [...scope, localName(node, source)].join(' / ');
      const occurrence = (occurrences.get(name) || 0) + 1;
      occurrences.set(name, occurrence);
      const start = source.getLineAndCharacterOfPosition(node.getStart(source));
      const end = source.getLineAndCharacterOfPosition(node.getEnd());
      functions.push({ file, name, occurrence, line: start.line + 1, column: start.character + 1, endLine: end.line + 1, ...countFunction(node) });
      childrenScope = [...scope, localName(node, source)];
    }
    ts.forEachChild(node, child => visit(child, childrenScope));
  }
  visit(source);
  return { file, sha256: createHash('sha256').update(text).digest('hex'), lines: text.split(/\r?\n/).length, functions };
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function summarize(functions) {
  const values = functions.map(item => item.complexity), total = values.reduce((sum, value) => sum + value, 0);
  return { functions: functions.length, totalComplexity: total, totalDecisions: total - functions.length,
    maximum: Math.max(0, ...values), mean: functions.length ? Number((total / functions.length).toFixed(3)) : 0,
    median: median(values), above10: values.filter(value => value > 10).length,
    above20: values.filter(value => value > 20).length, above50: values.filter(value => value > 50).length };
}

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(full) : /\.(?:[cm]?tsx?|[cm]?jsx?)$/i.test(entry.name) ? [full] : [];
  }).sort();
}

export function analyzeDirectory(directory, root = repositoryRoot) {
  const files = sourceFiles(directory).map(file => analyzeSource(path.relative(root, file).replaceAll('\\', '/'), fs.readFileSync(file, 'utf8')));
  const functions = files.flatMap(file => file.functions);
  return { version: 1, generatedAt: new Date().toISOString(), sourceRoot: path.relative(root, directory).replaceAll('\\', '/'), metric,
    summary: { files: files.length, ...summarize(functions) }, files: files.map(file => ({ ...file, summary: summarize(file.functions) })), functions };
}

const rankFunctions = functions => [...functions].sort((a, b) => b.complexity - a.complexity || a.file.localeCompare(b.file) || a.line - b.line);
const functionKey = item => `${item.file}\u0000${item.name}\u0000${item.occurrence}`;
export function compareReports(before, after) {
  if (JSON.stringify(before.metric) !== JSON.stringify(after.metric)) throw new Error('Cannot compare different complexity definitions.');
  const previous = new Map(before.functions.map(item => [functionKey(item), item]));
  const changedFunctions = after.functions.flatMap(item => {
    const old = previous.get(functionKey(item));
    if (!old || old.complexity === item.complexity) return [];
    return [{ file: item.file, name: item.name, occurrence: item.occurrence, beforeLine: old.line, afterLine: item.line,
      before: old.complexity, after: item.complexity, delta: item.complexity - old.complexity }];
  }).sort((a, b) => a.delta - b.delta || a.file.localeCompare(b.file) || a.afterLine - b.afterLine);
  const next = new Set(after.functions.map(functionKey)), oldFiles = new Map(before.files.map(file => [file.file, file]));
  return { beforeGeneratedAt: before.generatedAt, afterGeneratedAt: after.generatedAt,
    summary: Object.fromEntries(Object.keys(after.summary).map(key => [key, { before: before.summary[key], after: after.summary[key], delta: Number((after.summary[key] - before.summary[key]).toFixed(3)) }])),
    changedFiles: after.files.filter(file => oldFiles.get(file.file)?.sha256 !== file.sha256).map(file => ({ file: file.file,
      beforeSha256: oldFiles.get(file.file)?.sha256 ?? null, afterSha256: file.sha256, before: oldFiles.get(file.file)?.summary ?? null, after: file.summary })),
    changedFunctions, addedFunctions: after.functions.filter(item => !previous.has(functionKey(item))), removedFunctions: before.functions.filter(item => !next.has(functionKey(item))) };
}

const cell = value => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
function markdown(report, comparison) {
  const output = [`# Web source cyclomatic complexity`, '', `Source: \`${report.sourceRoot}\`. Snapshot: ${report.generatedAt}.`, '',
    'Method: base 1 per executable function, plus each if, loop, catch, ternary, non-default switch case, and && / || / ?? expression. Nested functions are counted independently. Optional chaining, else/default clauses, logical assignments and type syntax do not add decisions.', '',
    'This is a syntax-based maintainability indicator, not a test of correctness. JSX callbacks are included. Extraction can reduce the largest function while adding function bases; compare total decisions as well as maximum and threshold counts. SHA-256 hashes in the JSON identify exactly which source contents were measured.', '',
    '| Metric | Value |', '| --- | ---: |', ...Object.entries(report.summary).map(([key, value]) => `| ${key} | ${value} |`), '',
    '## Most complex functions', '', '| Complexity | Function | Location |', '| ---: | --- | --- |',
    ...rankFunctions(report.functions).slice(0, 50).map(item => `| ${item.complexity} | ${cell(item.name)} | ${item.file}:${item.line}:${item.column} |`), '',
    '## Every source file', '', '| File | Functions | Decisions | Maximum | Above 20 |', '| --- | ---: | ---: | ---: | ---: |',
    ...report.files.map(file => `| ${file.file} | ${file.summary.functions} | ${file.summary.totalDecisions} | ${file.summary.maximum} | ${file.summary.above20} |`), ''];
  if (comparison) output.push('## Before / after', '', '| Metric | Before | After | Change |', '| --- | ---: | ---: | ---: |',
    ...Object.entries(comparison.summary).map(([key, value]) => `| ${key} | ${value.before} | ${value.after} | ${value.delta} |`), '',
    'Function matching uses file, lexical name and occurrence, so renamed/extracted functions appear as additions/removals. Anonymous callback matching is approximate when callbacks are reordered.', '',
    '| Function | Before | After | Change | Location |', '| --- | ---: | ---: | ---: | --- |',
    ...comparison.changedFunctions.map(item => `| ${cell(item.name)} | ${item.before} | ${item.after} | ${item.delta} | ${item.file}:${item.afterLine} |`), '');
  return output.join('\n');
}

export function runCli(args = process.argv.slice(2)) {
  const options = { source: path.join(repositoryRoot, 'apps/web/src'), outDir: path.join(repositoryRoot, '.data/complexity'), label: 'current' };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--help') { console.log('node tools/analyze-web-complexity.mjs [--source directory] [--out-dir directory] [--label name] [--compare before.json]'); return; }
    const key = ({ '--source': 'source', '--out-dir': 'outDir', '--label': 'label', '--compare': 'compare' })[argument];
    if (!key || !args[index + 1]) throw new Error(`Unknown or incomplete option: ${argument}`);
    options[key] = args[++index];
  }
  if (!/^[A-Za-z0-9_-]+$/.test(options.label)) throw new Error('Label must contain only letters, digits, underscores or hyphens.');
  const report = analyzeDirectory(path.resolve(options.source));
  const comparison = options.compare ? compareReports(JSON.parse(fs.readFileSync(path.resolve(options.compare), 'utf8')), report) : null;
  fs.mkdirSync(path.resolve(options.outDir), { recursive: true });
  const basename = path.join(path.resolve(options.outDir), options.label);
  fs.writeFileSync(`${basename}.json`, JSON.stringify({ ...report, ...(comparison ? { comparison } : {}) }, null, 2) + '\n');
  fs.writeFileSync(`${basename}.md`, markdown(report, comparison));
  console.log(JSON.stringify({ summary: report.summary, reports: [`${basename}.json`, `${basename}.md`], top20: rankFunctions(report.functions).slice(0, 20).map(({ file, name, line, complexity }) => ({ file, name, line, complexity })) }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { runCli(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
