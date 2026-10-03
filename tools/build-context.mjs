// Only an active build/test coordinator can issue a recursive-build context.
// This is deliberately not a public "skip quality" switch or a persistent success stamp.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

export const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const contextDirectory = path.join(sourceRoot, '.data', 'quality', 'contexts');
const contextKey = 'SPARKSTUDIO_BUILD_CONTEXT';
const tokenKey = 'SPARKSTUDIO_BUILD_TOKEN';

export function issueBuildContext(ownerPid = process.pid) {
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) throw new Error('Invalid build context owner.');
  process.kill(ownerPid, 0);
  fs.mkdirSync(contextDirectory, { recursive: true });
  const token = randomBytes(32).toString('hex');
  const contextPath = path.join(contextDirectory, `${token}.json`);
  fs.writeFileSync(contextPath, JSON.stringify({ version: 1, root: sourceRoot, token, ownerPid }), { flag: 'wx', mode: 0o600 });
  return { contextPath, token, ownerPid };
}

export function removeBuildContext(contextPath, token) {
  if (!hasBuildContext({ [contextKey]: contextPath, [tokenKey]: token })) throw new Error('Invalid build context cleanup request.');
  fs.rmSync(contextPath, { force: true });
}

function readBuildContext(contextPath, token) {
  try {
    if (!contextPath || !/^[a-f0-9]{64}$/.test(token ?? '')) return null;
    if (path.dirname(path.resolve(contextPath)) !== path.resolve(contextDirectory)) return null;
    if (path.basename(contextPath) !== `${token}.json`) return null;
    const context = JSON.parse(fs.readFileSync(contextPath, 'utf8'));
    if (context.version !== 1 || context.root !== sourceRoot || context.token !== token
      || !Number.isSafeInteger(context.ownerPid) || context.ownerPid <= 0) return null;
    return context;
  } catch { return null; }
}

export function hasBuildContext(env = process.env) {
  try {
    const context = readBuildContext(env[contextKey], env[tokenKey]);
    if (!context) return false;
    // A stale context after interruption cannot exempt any later build.
    process.kill(context.ownerPid, 0);
    return true;
  } catch {
    return false;
  }
}

// Global properties keep SDK transitive references and explicit references in
// the same project instance. Environment-only context creates different graphs.
export function buildContextProperties(env = process.env) {
  if (!hasBuildContext(env)) throw new Error('An active build context is required for nested compiler work.');
  return [`-p:_QualityContextPath=${env[contextKey]}`, `-p:_QualityContextToken=${env[tokenKey]}`];
}

// Raw MSBuild can run Build followed by Publish without setting the CLI's
// _IsPublishing property. Keep its lease valid for all targets in that process.
export function deferBuildContextCleanup(contextPath, token) {
  if (!hasBuildContext({ [contextKey]: contextPath, [tokenKey]: token })) throw new Error('Invalid deferred build context cleanup request.');
  const child = spawn(process.execPath, [fileURLToPath(new URL('./build-quality.mjs', import.meta.url)), 'expire-context', contextPath, token], {
    detached: true, windowsHide: true, stdio: 'ignore',
  });
  child.unref();
}

export async function expireBuildContext(contextPath, token) {
  const context = readBuildContext(contextPath, token);
  if (!context) throw new Error('Invalid expired build context cleanup request.');
  while (hasBuildContext({ [contextKey]: contextPath, [tokenKey]: token })) await new Promise(resolve => setTimeout(resolve, 250));
  const current = readBuildContext(contextPath, token);
  if (current && current.ownerPid === context.ownerPid) fs.rmSync(contextPath, { force: true });
}

export async function withBuildContext(action) {
  if (hasBuildContext()) return action();
  const { contextPath, token } = issueBuildContext();
  const previousPath = process.env[contextKey];
  const previousToken = process.env[tokenKey];
  process.env[contextKey] = contextPath;
  process.env[tokenKey] = token;
  try {
    return await action();
  } finally {
    fs.rmSync(contextPath, { force: true });
    if (previousPath === undefined) delete process.env[contextKey]; else process.env[contextKey] = previousPath;
    if (previousToken === undefined) delete process.env[tokenKey]; else process.env[tokenKey] = previousToken;
  }
}
