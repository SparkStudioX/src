[CmdletBinding()]
param([switch]$SkipRestore)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
& (Join-Path $PSScriptRoot 'bootstrap.ps1')
$env:DOTNET_ROOT = Join-Path $root '.tools\dotnet'
$env:DOTNET_CLI_HOME = Join-Path $root '.tools\dotnet-home'
$env:NUGET_PACKAGES = Join-Path $root '.tools\nuget'
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$dotnet = Join-Path $env:DOTNET_ROOT 'dotnet.exe'
Push-Location $root
try {
    if (!$SkipRestore) {
        & $dotnet restore src/SparkStudio.Gateway --locked-mode --configfile NuGet.Config
        if ($LASTEXITCODE -ne 0) { throw 'Gateway dependency restore failed.' }
    }
    Push-Location (Join-Path $root 'apps\web')
    try {
        if (!$SkipRestore) {
            & npm.cmd ci --cache (Join-Path $root '.tools\npm-cache') --no-audit --no-fund
            if ($LASTEXITCODE -ne 0) { throw 'Browser dependency restore failed.' }
        }
        & npm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw 'Browser build failed.' }
    } finally { Pop-Location }
    $webRoot = Join-Path $root 'src\SparkStudio.Gateway\wwwroot'
    New-Item -ItemType Directory -Force -Path $webRoot | Out-Null
    Copy-Item -Path (Join-Path $root 'apps\web\dist\*') -Destination $webRoot -Recurse -Force
    & $dotnet build src/SparkStudio.Gateway --no-restore
    if ($LASTEXITCODE -ne 0) { throw 'Gateway build failed.' }
} finally { Pop-Location }
