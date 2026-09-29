[CmdletBinding()]
param([switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
if (!$SkipBuild) { & (Join-Path $PSScriptRoot 'build.ps1') }
$env:DOTNET_ROOT = Join-Path $root '.tools\dotnet'
$env:DOTNET_CLI_HOME = Join-Path $root '.tools\dotnet-home'
$env:NUGET_PACKAGES = Join-Path $root '.tools\nuget'
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$dotnet = Join-Path $env:DOTNET_ROOT 'dotnet.exe'
if (!(Test-Path -LiteralPath $dotnet)) { throw 'Run tools/bootstrap.ps1 to install the workspace .NET SDK.' }
if (!(Test-Path -LiteralPath (Join-Path $root 'src\SparkStudio.Gateway\wwwroot\index.html'))) { throw 'Build the browser application with tools/build.ps1 before publishing.' }
if (!(Test-Path -LiteralPath (Join-Path $root 'runtimes\python\windows-x64\python.exe'))) { throw 'Run tools/bootstrap.ps1 to prepare the bundled Python runtime.' }
$output = Join-Path $root 'artifacts\windows-x64'
Push-Location $root
try {
    & $dotnet publish src/SparkStudio.Gateway -c Release -r win-x64 --self-contained true -o $output --configfile NuGet.Config -p:NuGetLockFilePath=packages.win-x64.lock.json
    if ($LASTEXITCODE -ne 0) { throw 'Windows publish failed.' }
    $runtime = Join-Path $output 'runtimes\python\windows-x64'
    New-Item -ItemType Directory -Force -Path $runtime | Out-Null
    Copy-Item -Path (Join-Path $root 'runtimes\python\windows-x64\*') -Destination $runtime -Recurse -Force
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'install-service.ps1') -Destination $output -Force
    Write-Host "Self-contained gateway ready: $output\SparkStudio.Gateway.exe"
} finally { Pop-Location }
