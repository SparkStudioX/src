[CmdletBinding()]
param([switch]$NoBuild, [ValidateRange(1, 65535)][int]$Port = 5090)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
if (!$NoBuild) { & (Join-Path $PSScriptRoot 'build.ps1') }
$env:DOTNET_ROOT = Join-Path $root '.tools\dotnet'
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:SPARKSTUDIO_DATA_DIR = Join-Path $root '.data\development'
$env:ASPNETCORE_ENVIRONMENT = 'Development'
$assembly = Join-Path $root 'src\SparkStudio.Gateway\bin\Debug\net10.0\SparkStudio.Gateway.dll'
if (!(Test-Path -LiteralPath $assembly)) { throw 'Run tools/build.ps1 first.' }
$dotnet = Join-Path $env:DOTNET_ROOT 'dotnet.exe'
if (!(Test-Path -LiteralPath $dotnet)) { throw 'Run tools/bootstrap.ps1 to install the workspace .NET SDK.' }
Write-Host "SparkStudio: http://127.0.0.1:$Port"
& $dotnet $assembly --urls "http://127.0.0.1:$Port" --contentRoot (Join-Path $root 'src\SparkStudio.Gateway')
if ($LASTEXITCODE -ne 0) { throw "Gateway exited with code $LASTEXITCODE." }
