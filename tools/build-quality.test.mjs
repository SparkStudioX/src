import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sourceRoot, hasBuildContext, withBuildContext, issueBuildContext, buildContextProperties } from './build-context.mjs';
import { randomUUID } from 'node:crypto';
import { runQualityGates } from './quality-gates.mjs';

test('every failed quality gate prevents the artifact build', () => {
  for (let failedIndex = 0; failedIndex < 4; failedIndex++) {
    const results = [];
    let artifactBuilt = false;
    const stages = ['Frontend lint', 'Backend lint', 'Unit tests', 'Complexity'].map((name, index) => ({
      run: () => ({ name, passed: index !== failedIndex, exitCode: index === failedIndex ? 1 : 0 }),
    }));
    assert.throws(() => { runQualityGates(stages, result => results.push(result)); artifactBuilt = true; }, /Build stopped/);
    assert.equal(artifactBuilt, false);
    assert.equal(results.length, failedIndex + 1);
    assert.equal(results.at(-1).passed, false);
  }
});

test('valid nested MSBuild work uses the active context without recursing', async () => {
  await withBuildContext(async () => {
    assert.equal(hasBuildContext(), true);
    assert.deepEqual(buildContextProperties(), [`-p:_QualityContextPath=${process.env.SPARKSTUDIO_BUILD_CONTEXT}`, `-p:_QualityContextToken=${process.env.SPARKSTUDIO_BUILD_TOKEN}`]);
    const result = spawnSync(process.execPath, [path.join(sourceRoot, 'tools/build-quality.mjs'), 'msbuild'], { cwd: sourceRoot, env: process.env, encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.stdout, '');
  });
});

test('fresh coordinator cleans its context even after a failed gate', async () => {
  const savedPath = process.env.SPARKSTUDIO_BUILD_CONTEXT;
  const savedToken = process.env.SPARKSTUDIO_BUILD_TOKEN;
  delete process.env.SPARKSTUDIO_BUILD_CONTEXT;
  delete process.env.SPARKSTUDIO_BUILD_TOKEN;
  let issuedPath;
  try {
    await assert.rejects(withBuildContext(async () => {
      issuedPath = process.env.SPARKSTUDIO_BUILD_CONTEXT;
      assert.equal(hasBuildContext(), true);
      throw new Error('fixture gate failed');
    }), /fixture gate failed/);
    assert.equal(fs.existsSync(issuedPath), false);
    assert.equal(hasBuildContext(), false);
  } finally {
    if (savedPath !== undefined) process.env.SPARKSTUDIO_BUILD_CONTEXT = savedPath;
    if (savedToken !== undefined) process.env.SPARKSTUDIO_BUILD_TOKEN = savedToken;
  }
});

test('a skip-shaped environment value and an unrelated token are rejected', () => {
  assert.equal(hasBuildContext({ SPARKSTUDIO_BUILD_CONTEXT: 'true', SPARKSTUDIO_BUILD_TOKEN: 'skip' }), false);
  assert.equal(hasBuildContext({ SPARKSTUDIO_BUILD_CONTEXT: path.join(sourceRoot, '.data/quality/contexts', `${'a'.repeat(64)}.json`), SPARKSTUDIO_BUILD_TOKEN: 'a'.repeat(64) }), false);
  assert.throws(() => buildContextProperties({ SPARKSTUDIO_BUILD_CONTEXT: 'true', SPARKSTUDIO_BUILD_TOKEN: 'skip' }), /active build context/);
});

test('frontend lint rejects a real correctness defect', async () => {
  const { ESLint } = await import('../apps/web/node_modules/eslint/lib/api.js');
  const lint = new ESLint({ cwd: path.join(sourceRoot, 'apps/web') });
  const [result] = await lint.lintText('export function example(value: string) { return value === value; }', { filePath: path.join(sourceRoot, 'apps/web/src/quality-fixture.ts') });
  assert.ok(result.messages.some(message => message.ruleId === 'no-self-compare' && message.severity === 2));
});

test('Build cleanup preserves an owned lease for later Publish targets and expires it when MSBuild exits', async () => {
  const owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
  const { contextPath, token } = issueBuildContext(owner.pid);
  const receipt = path.join(sourceRoot, '.data/quality/msbuild', `${randomUUID()}.txt`);
  fs.mkdirSync(path.dirname(receipt), { recursive: true });
  fs.writeFileSync(receipt, `${contextPath}\n${token}\ntrue\n`);
  try {
    const result = spawnSync(process.execPath, [path.join(sourceRoot, 'tools/build-quality.mjs'), 'release-msbuild', receipt, 'after-build'], { cwd: sourceRoot, encoding: 'utf8', timeout: 10_000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.existsSync(receipt), false);
    assert.equal(hasBuildContext({ SPARKSTUDIO_BUILD_CONTEXT: contextPath, SPARKSTUDIO_BUILD_TOKEN: token }), true);
    owner.kill();
    for (let attempt = 0; attempt < 40 && fs.existsSync(contextPath); attempt++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(fs.existsSync(contextPath), false, 'An exited MSBuild owner must leave no reusable lease.');
  } finally { owner.kill(); fs.rmSync(receipt, { force: true }); fs.rmSync(contextPath, { force: true }); }
});
