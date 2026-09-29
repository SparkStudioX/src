[CmdletBinding()]
param([switch]$SkipBuild, [string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
$gitRoot = $root.Replace('\', '/')

function Get-CleanSourceCommit {
    $commit = & git -c "safe.directory=$gitRoot" -C $root rev-parse HEAD
    if ($LASTEXITCODE -ne 0 -or $commit -notmatch '^[0-9a-f]{40}$') { throw 'Cannot identify the source commit.' }
    $changes = & git -c "safe.directory=$gitRoot" -C $root status --porcelain=v1 --untracked-files=all
    if ($LASTEXITCODE -ne 0 -or $changes) { throw 'Release publishing requires a clean source checkout. Commit reviewed source changes first; ignored local data is excluded.' }
    return $commit
}
function Assert-PayloadPath([string]$Relative) {
    if ($Relative -match '(^|[\\/])(data|\.data|gwbk|keyring|logs|pki|keys|certificates|security|node_modules|__pycache__)([\\/]|$)' -or
        [IO.Path]::GetExtension($Relative) -in @('.pfx', '.p12', '.key', '.pem', '.cer', '.crt', '.der', '.gwbk', '.db', '.sqlite', '.sqlite3', '.log', '.pyc')) {
        throw "Private/development data is not allowed in the release payload: $Relative"
    }
}
function Assert-NoReparsePath([string]$Path) {
    $cursor = [IO.Path]::GetFullPath($Path)
    while ($cursor.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
        if ((Test-Path -LiteralPath $cursor) -and ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Release paths cannot traverse a reparse point: $cursor" }
        if ($cursor -eq $root) { break }
        $cursor = Split-Path $cursor -Parent
    }
}
function Assert-GeneratedWebRoot {
    $expectedWebRoot = [IO.Path]::GetFullPath((Join-Path $root 'src\SparkStudio.Gateway')) + [IO.Path]::DirectorySeparatorChar + 'wwwroot'
    if ($webRoot -ne $expectedWebRoot -or !$webRoot.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Generated web-root boundary check failed.' }
    Assert-NoReparsePath $webRoot
    if ((Test-Path -LiteralPath $webRoot) -and @(Get-ChildItem -LiteralPath $webRoot -Force -Recurse | Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 }).Count) { throw 'Generated web root cannot contain reparse points.' }
}

$sourceCommit = Get-CleanSourceCommit
[xml]$project = Get-Content -LiteralPath (Join-Path $root 'src\SparkStudio.Gateway\SparkStudio.Gateway.csproj') -Raw
$version = [string]$project.Project.PropertyGroup.Version
$fileVersion = [string]$project.Project.PropertyGroup.FileVersion
if ($version -notmatch '^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$' -or $fileVersion -notmatch '^\d+\.\d+\.\d+\.\d+$') { throw 'Explicit product and Windows file versions are required.' }
if (!$OutputDirectory) { $OutputDirectory = Join-Path $root "artifacts\windows-x64-$version" }
$output = [IO.Path]::GetFullPath($OutputDirectory)
$artifactRoot = [IO.Path]::GetFullPath((Join-Path $root 'artifacts'))
if (!$output.StartsWith($artifactRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Publish output must be a new directory under this checkout artifacts folder.' }
Assert-NoReparsePath $output
if (Test-Path -LiteralPath $output) { throw "Publish output already exists: $output. Choose a new -OutputDirectory; releases never merge with an older payload." }

# build.ps1 copies into this generated folder, so validate before invoking it too.
$webRoot = [IO.Path]::GetFullPath((Join-Path $root 'src\SparkStudio.Gateway\wwwroot'))
Assert-GeneratedWebRoot

# SkipBuild skips dependency bootstrap/restore, but never reuses an old browser build.
if (!$SkipBuild) { & (Join-Path $PSScriptRoot 'build.ps1') }
else {
    Push-Location (Join-Path $root 'apps\web')
    try { & npm.cmd run build; if ($LASTEXITCODE -ne 0) { throw 'Browser build failed.' } }
    finally { Pop-Location }
}
$env:DOTNET_ROOT = Join-Path $root '.tools\dotnet'
$env:DOTNET_CLI_HOME = Join-Path $root '.tools\dotnet-home'
$env:NUGET_PACKAGES = Join-Path $root '.tools\nuget'
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$dotnet = Join-Path $env:DOTNET_ROOT 'dotnet.exe'
if (!(Test-Path -LiteralPath $dotnet)) { throw 'Run tools/bootstrap.ps1 to install the workspace .NET SDK.' }
$dist = Join-Path $root 'apps\web\dist'
$indexPath = Join-Path $dist 'index.html'
if (!(Test-Path -LiteralPath $indexPath)) { throw 'Browser index is missing from the fresh build.' }
$browserEntry = [regex]::Match((Get-Content -LiteralPath $indexPath -Raw), '/assets/index-[A-Za-z0-9_-]+\.js').Value
if (!$browserEntry -or !(Test-Path -LiteralPath (Join-Path $dist $browserEntry.TrimStart('/')))) { throw 'The browser entry bundle is missing.' }
$browser = [ordered]@{ entry = $browserEntry; sha256 = (Get-FileHash -LiteralPath (Join-Path $dist $browserEntry.TrimStart('/')) -Algorithm SHA256).Hash.ToLowerInvariant() }
$pythonSource = Join-Path $root 'runtimes\python\windows-x64'
if (!(Test-Path -LiteralPath (Join-Path $pythonSource 'python.exe'))) { throw 'Run tools/bootstrap.ps1 to prepare the bundled Python runtime.' }

# This exact ignored folder is generated by build.ps1. Clear it before SDK static-asset
# discovery, so obsolete hashed bundles and compressed siblings cannot enter the publish.
Assert-GeneratedWebRoot
if (Test-Path -LiteralPath $webRoot) {
    Remove-Item -LiteralPath $webRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $webRoot | Out-Null
Copy-Item -Path (Join-Path $dist '*') -Destination $webRoot -Recurse

Push-Location $root
try {
    & $dotnet publish src/SparkStudio.Gateway -c Release -r win-x64 --self-contained true -o $output --configfile NuGet.Config -p:NuGetLockFilePath=packages.win-x64.lock.json -p:RestoreLockedMode=true "-p:SourceRevisionId=$sourceCommit"
    if ($LASTEXITCODE -ne 0) { throw 'Windows publish failed. Its incomplete directory is preserved; choose a fresh output for the next attempt.' }
    $runtime = Join-Path $output 'runtimes\python\windows-x64'
    New-Item -ItemType Directory -Path $runtime -Force | Out-Null
    Copy-Item -Path (Join-Path $pythonSource '*') -Destination $runtime -Recurse
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'install-service.ps1') -Destination $output
    if ((Get-CleanSourceCommit) -ne $sourceCommit) { throw 'Source changed during publishing; this package cannot be released.' }
    $assembly = [Diagnostics.FileVersionInfo]::GetVersionInfo((Join-Path $output 'SparkStudio.Gateway.dll'))
    if ($assembly.FileVersion -ne $fileVersion -or !$assembly.ProductVersion.StartsWith($version + '+') -or !$assembly.ProductVersion.Contains($sourceCommit)) { throw 'Gateway assembly version/provenance does not match this source build.' }
    if (@(Get-ChildItem -LiteralPath $output -Force -Recurse | Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 }).Count) { throw 'Release payload cannot contain reparse points.' }
    $files = @(Get-ChildItem -LiteralPath $output -File -Recurse | Sort-Object FullName | ForEach-Object {
        if (($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Release payload cannot contain file links.' }
        $relative = $_.FullName.Substring($output.Length + 1).Replace('\', '/')
        Assert-PayloadPath $relative
        [ordered]@{ path = $relative; size = $_.Length; sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
    })
    $manifest = [ordered]@{ formatVersion = 1; product = 'SparkStudio'; version = $version; fileVersion = $fileVersion; platform = 'windows-x64'; sourceCommit = $sourceCommit; sourceDirty = $false; browser = $browser; generatedAtUtc = [DateTime]::UtcNow.ToString('o'); files = $files }
    $manifest | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath (Join-Path $output 'publish-manifest.json') -Encoding utf8
    Write-Host "Self-contained gateway ready: $output\SparkStudio.Gateway.exe"
    Write-Host "Source $sourceCommit; browser $browserEntry; version $version"
} finally { Pop-Location }
