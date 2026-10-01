#!/usr/bin/env node
// Local temporary files and loopback FTP/S3 fixtures only; no installed gateway data or real remote credentials.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { root, dotnet, testEnv } from './test-environment.mjs';
const directory = path.join(root, '.data/test-evidence', `backup-destinations-${randomUUID()}`);
await mkdir(directory, { recursive: true });
const xml = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
await writeFile(path.join(directory, 'Check.csproj'), `<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup><ItemGroup>${['BackupDestinations.cs', 'BackupS3Destination.cs', 'GatewayRecovery.cs', 'DataDirectoryLease.cs'].map(file => `<Compile Include="${xml(path.join(root, 'src/SparkStudio.Gateway', file))}" Link="${file}"/>`).join('')}<PackageReference Include="AWSSDK.S3" Version="4.0.104"/><Compile Include="${xml(path.join(root, 'tools/fixtures/BackupDestinationChecks.cs'))}" Link="Program.cs"/><Compile Include="${xml(path.join(root, 'tools/fixtures/BackupS3Checks.cs'))}" Link="BackupS3Checks.cs"/></ItemGroup></Project>`);
await writeFile(path.join(directory, 'NuGet.Config'), '<configuration><packageSources><clear/></packageSources></configuration>');
await mkdir(path.join(directory, 'dotnet-roaming'), { recursive: true });
const options = { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 180000, env: testEnv };
for (const args of [ ['restore', path.join(directory, 'Check.csproj'), '--configfile', path.join(directory, 'NuGet.Config'), '-p:NuGetAudit=false', '--verbosity', 'quiet'], ['run', '--project', path.join(directory, 'Check.csproj'), '--no-restore', '--no-launch-profile', '--verbosity', 'quiet'] ]) {
 const result = spawnSync(dotnet, args, options);
 process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
 assert.equal(result.status, 0, `Backup destination fixture failed (${result.error?.message ?? 'see output'}).`);
}
console.log(`Evidence: ${directory}`);
