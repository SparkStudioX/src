[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$repositoryPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js is required to run the source boundary hooks.' }
$gitTop = (& git -C $repositoryPath rev-parse --show-toplevel)
if ($LASTEXITCODE -ne 0) { throw 'Run this helper from an initialized SparkStudio source repository.' }
if ([IO.Path]::GetFullPath($gitTop.Trim()) -ne $repositoryPath) { throw 'Refusing to install hooks in a parent or different repository.' }
& git -C $repositoryPath config --local core.hooksPath .githooks
if ($LASTEXITCODE -ne 0) { throw 'Could not configure repository-local hooks.' }
Write-Host 'Source boundary hooks enabled for this repository (.githooks).'
Write-Host 'Commits inspect the staged Git blobs. Pushes inspect every reachable commit in the pushed history.'
Write-Host 'Hooks can be bypassed; CI and independent source/secret review are still required.'
