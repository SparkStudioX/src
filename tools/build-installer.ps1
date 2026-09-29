[CmdletBinding()]
param([switch]$SkipHelperBuild, [string]$CompilerPath, [string]$PublishedDirectory)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
$gitRoot = $root.Replace('\', '/')
[xml]$project = Get-Content -LiteralPath (Join-Path $root 'src\SparkStudio.Gateway\SparkStudio.Gateway.csproj') -Raw
$version = [string]$project.Project.PropertyGroup.Version
$fileVersion = [string]$project.Project.PropertyGroup.FileVersion
$assemblyVersion = [string]$project.Project.PropertyGroup.AssemblyVersion
if (!$PublishedDirectory) { $PublishedDirectory = Join-Path $root "artifacts\windows-x64-$version" }
$published = [IO.Path]::GetFullPath($PublishedDirectory)
$artifactRoot = [IO.Path]::GetFullPath((Join-Path $root 'artifacts'))
if (!$published.StartsWith($artifactRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'The published payload must be under this checkout artifacts folder.' }
$output = Join-Path $root 'artifacts\installer'
$helper = Join-Path $root ('.data\installer-helper-' + [guid]::NewGuid().ToString('N'))
$compilerVersion = '7.1.0'
$compilerSha256 = '0362a383ed217d4c4239b5933866dd96d3eb2102737da92f80f6057a4b40df2f'

function Get-CleanSourceCommit {
    $commit = & git -c "safe.directory=$gitRoot" -C $root rev-parse HEAD
    if ($LASTEXITCODE -ne 0 -or $commit -notmatch '^[0-9a-f]{40}$') { throw 'Cannot identify the source commit.' }
    $changes = & git -c "safe.directory=$gitRoot" -C $root status --porcelain=v1 --untracked-files=all
    if ($LASTEXITCODE -ne 0 -or $changes) { throw 'Installer releases require a clean, reviewed source checkout.' }
    return $commit
}
$sourceCommit = Get-CleanSourceCommit
if ($SkipHelperBuild) { throw 'Release installers always build the service helper from the current source; -SkipHelperBuild is not supported.' }
if (@(Get-ChildItem -LiteralPath $published -Force -Recurse | Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 }).Count) { throw 'Published payload cannot contain reparse points.' }
$publishManifestPath = Join-Path $published 'publish-manifest.json'
if (!(Test-Path -LiteralPath $publishManifestPath)) { throw 'Publish provenance is missing. Run tools/publish-windows.ps1 first.' }
$provenance = Get-Content -LiteralPath $publishManifestPath -Raw | ConvertFrom-Json
if ($provenance.formatVersion -ne 1 -or $provenance.product -ne 'SparkStudio' -or $provenance.version -ne $version -or $provenance.fileVersion -ne $fileVersion -or $provenance.sourceCommit -ne $sourceCommit -or $provenance.sourceDirty -ne $false) { throw 'Published version/source provenance does not match this clean checkout. Publish a fresh payload.' }
$payloadFiles = @(Get-ChildItem -LiteralPath $published -File -Recurse | Where-Object FullName -ne $publishManifestPath)
if ($payloadFiles.Count -ne $provenance.files.Count) { throw 'Published payload inventory changed after publishing.' }
$paths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($entry in $provenance.files) {
    if ([IO.Path]::IsPathRooted($entry.path) -or !$paths.Add($entry.path)) { throw 'Invalid or duplicate publish-manifest path.' }
    $path = [IO.Path]::GetFullPath((Join-Path $published $entry.path))
    if (!$path.StartsWith($published + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or !(Test-Path -LiteralPath $path -PathType Leaf)) { throw 'A publish-manifest path is missing or escaped its payload.' }
    if ((Get-Item -LiteralPath $path).Length -ne $entry.size -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $entry.sha256) { throw "Published payload changed: $($entry.path)" }
}
$browserEntry = [regex]::Match((Get-Content -LiteralPath (Join-Path $published 'wwwroot\index.html') -Raw), '/assets/index-[A-Za-z0-9_-]+\.js').Value
if (!$browserEntry -or $browserEntry -ne $provenance.browser.entry -or (Get-FileHash -LiteralPath (Join-Path $published ('wwwroot' + $browserEntry)) -Algorithm SHA256).Hash -ne $provenance.browser.sha256) { throw 'Browser entry/provenance mismatch.' }

if (!$CompilerPath) {
    $compilerDirectory = Join-Path $root ".tools\inno-$compilerVersion"
    $CompilerPath = Join-Path $compilerDirectory 'ISCC.exe'
    if (!(Test-Path -LiteralPath $CompilerPath)) {
        $downloadDirectory = Join-Path $root '.tools\inno-download'
        New-Item -ItemType Directory -Force -Path $downloadDirectory | Out-Null
        $download = Join-Path $downloadDirectory "innosetup-$compilerVersion-x64.exe"
        if (!(Test-Path -LiteralPath $download)) {
            Invoke-WebRequest -Uri "https://github.com/jrsoftware/issrc/releases/download/is-7_1_0/innosetup-$compilerVersion-x64.exe" -OutFile $download
        }
        if ((Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash -ne $compilerSha256) { throw 'Official Inno Setup compiler checksum mismatch.' }
        $signature = Get-AuthenticodeSignature -LiteralPath $download
        if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'CN=Pyrsys B.V.,') { throw 'Inno Setup compiler publisher signature is not valid.' }
        $extract = Start-Process -FilePath $download -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/CURRENTUSER', '/PORTABLE=1', ('/DIR="{0}"' -f $compilerDirectory)) -WindowStyle Hidden -Wait -PassThru
        if ($extract.ExitCode -ne 0) { throw "Portable compiler preparation failed ($($extract.ExitCode))." }
    }
}
$CompilerPath = (Resolve-Path -LiteralPath $CompilerPath).Path
$compilerSignature = Get-AuthenticodeSignature -LiteralPath $CompilerPath
if ($compilerSignature.Status -ne 'Valid' -or $compilerSignature.SignerCertificate.Subject -notmatch 'CN=Pyrsys B.V.,') { throw 'The compiler does not have the expected valid publisher signature.' }

foreach ($required in @('SparkStudio.Gateway.exe', 'hostfxr.dll', 'coreclr.dll', 'wwwroot\index.html', 'runtimes\python\windows-x64\python.exe', 'runtimes\python\windows-x64\LICENSE.txt', 'python\worker.py')) {
    if (!(Test-Path -LiteralPath (Join-Path $published $required))) { throw "Missing offline payload file: $required. Run tools/publish-windows.ps1 first." }
}
$env:DOTNET_ROOT = Join-Path $root '.tools\dotnet'
$env:DOTNET_CLI_HOME = Join-Path $root '.tools\dotnet-home'
$env:NUGET_PACKAGES = Join-Path $root '.tools\nuget'
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
Push-Location $root
try {
    if (!$SkipHelperBuild) {
        & "$env:DOTNET_ROOT\dotnet.exe" publish installer/ServiceHelper/ServiceHelper.csproj -c Release -r win-x64 --self-contained true -o $helper --configfile NuGet.Config -p:NuGetLockFilePath=packages.win-x64.lock.json -p:RestoreLockedMode=true "-p:Version=$version" "-p:FileVersion=$fileVersion" "-p:AssemblyVersion=$assemblyVersion" "-p:SourceRevisionId=$sourceCommit"
        if ($LASTEXITCODE -ne 0) { throw 'Installer helper build failed.' }
    }
    $helperExe = Join-Path $helper 'SparkStudio.ServiceHelper.exe'
    if (!(Test-Path -LiteralPath $helperExe)) { throw 'Installer helper has not been built.' }
    & $helperExe --action self-test
    if ($LASTEXITCODE -ne 0) { throw 'Installer ownership/lifecycle tests failed.' }
    New-Item -ItemType Directory -Force -Path $output | Out-Null
    # Use a fresh stage: no stale files from a previous installer build can enter the payload.
    $stage = Join-Path $root ('.data\installer-stage-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $stage | Out-Null
    $files = @(Get-ChildItem -LiteralPath $published -File -Recurse)
    foreach ($file in $files) {
        $relative = $file.FullName.Substring($published.Length + 1)
        if ($relative -match '(^|\\)(data|\.data|gwbk|keyring|logs|pki|keys|certificates|security|node_modules|__pycache__)(\\|$)' -or $file.Extension -in @('.pfx', '.p12', '.key', '.pem', '.cer', '.crt', '.der', '.gwbk', '.db', '.sqlite', '.sqlite3', '.log', '.pyc')) {
            throw "Private/development data is not allowed in the installer: $relative"
        }
        $destination = Join-Path $stage $relative
        New-Item -ItemType Directory -Force -Path (Split-Path $destination -Parent) | Out-Null
        Copy-Item -LiteralPath $file.FullName -Destination $destination
    }
    Copy-Item -LiteralPath $helperExe -Destination $stage
    $notices = Join-Path $stage 'THIRD-PARTY-NOTICES'
    New-Item -ItemType Directory -Path $notices | Out-Null
    foreach ($entry in @(
        @('.tools\dotnet\LICENSE.txt', 'dotnet-LICENSE.txt'),
        @('.tools\dotnet\ThirdPartyNotices.txt', 'dotnet-ThirdPartyNotices.txt')
    )) { Copy-Item -LiteralPath (Join-Path $root $entry[0]) -Destination (Join-Path $notices $entry[1]) }
    # Inventory installed production dependencies, including transitive editor packages.
    # Only license/notice texts are copied; never package JavaScript or other source files.
    $web = Join-Path $root 'apps\web'
    $browserLock = Get-Content -LiteralPath (Join-Path $web 'package-lock.json') -Raw | ConvertFrom-Json
    $browserDirectories = @(& npm.cmd --prefix $web ls --omit=dev --all --parseable)
    if ($LASTEXITCODE -ne 0) { throw 'Cannot enumerate installed browser production dependencies.' }
    $browserPackages = @()
    foreach ($packageDirectory in ($browserDirectories | Where-Object { $_ -ne $web } | Sort-Object -Unique)) {
        $packageDirectory = [IO.Path]::GetFullPath($packageDirectory)
        if (!$packageDirectory.StartsWith($web + '\node_modules\', [StringComparison]::OrdinalIgnoreCase)) { throw 'A browser production dependency is outside the installed dependency directory.' }
        if (((Get-Item -LiteralPath $packageDirectory).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Browser production dependency links are not supported in release packaging.' }
        $metadata = Get-Content -LiteralPath (Join-Path $packageDirectory 'package.json') -Raw | ConvertFrom-Json
        if ($metadata.name -notmatch '^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$' -or $metadata.version -notmatch '^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.+-]+)?$') { throw 'Invalid browser package identity.' }
        $lockPath = $packageDirectory.Substring($web.Length + 1).Replace('\', '/')
        $lockedPackage = $browserLock.packages.PSObject.Properties[$lockPath].Value
        if (!$lockedPackage -or $lockedPackage.version -ne $metadata.version) { throw "Installed browser dependency does not match the lockfile: $($metadata.name)" }
        $licenseFiles = @(Get-ChildItem -LiteralPath $packageDirectory -File -Recurse | Where-Object {
            $relative = $_.FullName.Substring($packageDirectory.Length + 1)
            $_.Name -match '^(LICENSE|LICENCE|COPYING|NOTICE|ThirdPartyNotices)([.-]|$)' -and
                $_.Extension -in @('', '.txt', '.md') -and $relative -notmatch '(^|\\)node_modules(\\|$)'
        })
        if (!$licenseFiles.Count) { throw "No distributable license/notice text found for browser dependency $($metadata.name)." }
        $copiedNotices = @()
        foreach ($notice in $licenseFiles) {
            if (($notice.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Browser license files cannot be links.' }
            $relative = $notice.FullName.Substring($packageDirectory.Length + 1)
            $destination = Join-Path $notices (Join-Path 'browser' (Join-Path $metadata.name (Join-Path $metadata.version $relative)))
            New-Item -ItemType Directory -Force -Path (Split-Path $destination -Parent) | Out-Null
            Copy-Item -LiteralPath $notice.FullName -Destination $destination
            $copiedNotices += $destination.Substring($notices.Length + 1).Replace('\', '/')
        }
        $browserPackages += [ordered]@{ name = $metadata.name; version = $metadata.version; license = $metadata.license; integrity = $lockedPackage.integrity; notices = $copiedNotices }
    }
    if (!$browserPackages.Count) { throw 'The browser production dependency inventory is empty.' }
    $browserPackages | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $notices 'browser-package-inventory.json') -Encoding utf8
    Copy-Item -LiteralPath (Join-Path $root 'installer\INSTALL-NOTES.txt') -Destination $stage
    if (Test-Path -LiteralPath (Join-Path $root 'docs\architecture\WINDOWS_INSTALLER.md')) {
        Copy-Item -LiteralPath (Join-Path $root 'docs\architecture\WINDOWS_INSTALLER.md') -Destination $stage
    }
    # Preserve available NuGet package licenses and identify every published dependency.
    $deps = Get-Content -LiteralPath (Join-Path $published 'SparkStudio.Gateway.deps.json') -Raw | ConvertFrom-Json
    $packages = @()
    foreach ($property in $deps.libraries.PSObject.Properties) {
        $packages += [ordered]@{ name = $property.Name; type = $property.Value.type; hash = $property.Value.sha512 }
        if ($property.Value.type -eq 'package') {
            $packageDirectory = Join-Path $env:NUGET_PACKAGES $property.Value.path
            if (Test-Path -LiteralPath $packageDirectory) {
                $packageNotices = @(Get-ChildItem -LiteralPath $packageDirectory -File -Recurse | Where-Object { $_.Name -match '^(LICENSE|LICENCE|NOTICE|ThirdPartyNotices)(\.|$)' })
                foreach ($notice in $packageNotices) {
                    $relative = $notice.FullName.Substring($packageDirectory.Length + 1)
                    $destination = Join-Path $notices (Join-Path $property.Name.Replace('/', '\') $relative)
                    New-Item -ItemType Directory -Force -Path (Split-Path $destination -Parent) | Out-Null
                    Copy-Item -LiteralPath $notice.FullName -Destination $destination
                }
            }
        }
    }
    $packages | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $notices 'package-inventory.json') -Encoding utf8
    $manifestFiles = @(Get-ChildItem -LiteralPath $stage -File -Recurse | Sort-Object FullName | ForEach-Object {
        [ordered]@{ path = $_.FullName.Substring($stage.Length + 1).Replace('\', '/'); size = $_.Length; sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
    })
    if ((Get-CleanSourceCommit) -ne $sourceCommit) { throw 'Source changed during installer preparation; publish a fresh payload from the final source commit.' }
    $manifest = [ordered]@{ formatVersion = 1; product = 'SparkStudio'; version = $version; fileVersion = $fileVersion; platform = 'windows-x64'; sourceCommit = $sourceCommit; sourceDirty = $false; browser = $provenance.browser; unsigned = $true; generatedAtUtc = [DateTime]::UtcNow.ToString('o'); files = $manifestFiles }
    $manifestPath = Join-Path $stage 'package-manifest.json'
    $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestPath -Encoding utf8
    Copy-Item -LiteralPath $manifestPath -Destination (Join-Path $output 'package-manifest.json') -Force
    & $CompilerPath '/Qp' ('/DPayloadDir=' + $stage) ('/DOutputFolder=' + $output) ('/DAppVersion=' + $version) ('/DNumericVersion=' + $fileVersion) (Join-Path $root 'installer\SparkStudio.iss')
    if ($LASTEXITCODE -ne 0) { throw 'Inno Setup compilation failed.' }
    if ((Get-CleanSourceCommit) -ne $sourceCommit) { throw 'Source changed during installer compilation; this output cannot be released.' }
    $installer = Join-Path $output "SparkStudio-Setup-$version-windows-x64-unsigned.exe"
    $installerVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($installer)
    if ($installerVersion.FileVersion -ne $version -and $installerVersion.FileVersion -ne $fileVersion) { throw 'Compiled installer version does not match the release version.' }
    if ((@($installerVersion.FileMajorPart, $installerVersion.FileMinorPart, $installerVersion.FileBuildPart, $installerVersion.FilePrivatePart) -join '.') -ne $fileVersion) { throw 'Compiled installer numeric file version does not match the release version.' }
    $hash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
    "$hash  $([IO.Path]::GetFileName($installer))" | Set-Content -LiteralPath "$installer.sha256" -Encoding ascii
    [ordered]@{ installer = $installer; size = (Get-Item -LiteralPath $installer).Length; sha256 = $hash; payloadFileCount = $manifestFiles.Count; version = $version; fileVersion = $fileVersion; sourceCommit = $sourceCommit; sourceDirty = $false; browser = $provenance.browser; stage = $stage; compiler = $CompilerPath; unsigned = $true } | ConvertTo-Json -Depth 6 | Tee-Object -FilePath (Join-Path $output 'build-result.json')
} finally { Pop-Location }
