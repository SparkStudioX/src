[CmdletBinding()]
param([switch]$SkipHelperBuild, [string]$CompilerPath, [string]$PublishedDirectory)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
$gitRoot = $root.Replace('\', '/')
& node (Join-Path $PSScriptRoot 'version.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Release versions are inconsistent.' }
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

function Get-ReviewedPackageNoticeSpec([string]$Package) {
    # Supplements are explicit version reviews, never a blanket SPDX exemption.
    # Microsoft revisions come from each matching nuspec. SQLite's commit is the
    # resolved v2.1.12 tag; AWS's revision declares the exact assembly versions.
    $revision = $null; $family = $null
    if ($Package -in @('libplctag/1.5.2', 'libplctag.NativeImport/1.0.41')) {
        $revision = if ($Package -eq 'libplctag/1.5.2') { '343d1b0edeb7fcbae5d56e81477af7b3dc5b05fa' } else { '6ba1b192553372e65fb10eb6a0f1fb577890bdb9' }
        $sources = @("https://github.com/libplctag/libplctag.NET/tree/$revision")
        if ($Package -eq 'libplctag.NativeImport/1.0.41') { $sources += 'https://github.com/libplctag/libplctag/tree/b3dd0551b6d98fa6dc92e57a6ad0a76e3035b258' }
        return @{ repository = 'libplctag/libplctag.NET'; revision = $revision; license = 'MPL-2.0'; sourceAvailability = $sources; files = @(@{ name = 'LICENSE'; sha256 = '1f256ecad192880510e84ad60474eab7589218784b9a50bc7ceee34c2b91f1d5' }) }
    }
    if ($Package -eq 'S7netplus/0.20.0') {
        return @{ repository = 'killnine/s7netplus'; revision = 'f1ae0ea084e712b59e414de6aaee7d196244a239'; license = 'MIT'; licenseDeclarationAbsent = $true; files = @(@{ name = 'License.txt'; sha256 = '8b41113cbe0e258b882c1f2eccb36174ca96e02a7bf8f23ea0260b14b769ea8e' }) }
    }
    if ($Package -eq 'System.Reactive/6.1.0') {
        return @{ repository = 'dotnet/reactive'; revision = 'f4da16f15a3cde97f178396ea6e3489cc893651f'; license = 'MIT'; files = @(@{ name = 'LICENSE'; sha256 = 'cfc21f5e8bd655ae997eec916138b707b1d290b83272c02a95c9f821b8c87310' }) }
    }
    if ($Package -in @('AWSSDK.S3/4.0.104', 'AWSSDK.Core/4.0.102.8')) { $family = 'aws'; $revision = 'f5257515bbd26d04376ee826d07ec80ea267c9b9' }
    elseif ($Package -in @('SQLitePCLRaw.bundle_e_sqlite3/2.1.12', 'SQLitePCLRaw.core/2.1.12', 'SQLitePCLRaw.lib.e_sqlite3/2.1.12', 'SQLitePCLRaw.provider.e_sqlite3/2.1.12')) { $family = 'sqlite'; $revision = 'ca835d21508bff43121c65081035840ac5006c4c' }
    elseif ($Package -in @('Microsoft.Data.SqlClient/7.0.3', 'Microsoft.Data.SqlClient.Extensions.Abstractions/7.0.3', 'Microsoft.Data.SqlClient.Internal.Logging/7.0.3', 'Microsoft.SqlServer.Server/1.0.0')) {
        # SqlServer.Server's nuspec identifies this repository but no commit.
        # Its MIT declaration was reviewed against this applicable family text.
        $family = 'sqlclient'; $revision = 'daadd381d1da478c8f13ea220ecb9a4a2ef7d076'
    }
    elseif ($Package -in @('Microsoft.Data.Sqlite/10.0.12', 'Microsoft.Data.Sqlite.Core/10.0.12')) { $family = 'efcore'; $revision = '95017c711e6afc1085133d440e42b4bd78155701' }
    elseif ($Package -in @('Microsoft.Extensions.Hosting.WindowsServices/10.0.9', 'System.ServiceProcess.ServiceController/10.0.9')) { $family = 'runtime'; $revision = '901ca941248413c79832d2fdbd709da0c4386353' }
    elseif ($Package -in @('System.ComponentModel.Composition/10.0.11', 'System.ServiceProcess.ServiceController/10.0.11')) { $family = 'runtime'; $revision = 'e2f47b0110ed922f21a1522da67279133ce28f32' }
    elseif ($Package -in @('Microsoft.IdentityModel.Abstractions/8.16.0', 'Microsoft.IdentityModel.JsonWebTokens/8.16.0', 'Microsoft.IdentityModel.Logging/8.16.0', 'Microsoft.IdentityModel.Protocols/8.16.0', 'Microsoft.IdentityModel.Protocols.OpenIdConnect/8.16.0', 'Microsoft.IdentityModel.Tokens/8.16.0', 'System.IdentityModel.Tokens.Jwt/8.16.0')) { $family = 'identity'; $revision = 'f8172402e711c043a59bef81bba2609cf1fb9f46' }
    if (!$family) { return $null }
    $license = 'MIT'
    switch ($family) {
        'aws' {
            $repository = 'aws/aws-sdk-net'; $license = 'Apache-2.0'
            $files = @(
                @{ name = 'License.txt'; sha256 = '192898453336a3f666e8138988cdda21ee7b858b1184e00c882c531df174d0d1' },
                @{ name = 'Notice.txt'; sha256 = 'ebc5492b4c77f9c52a8d33d27588e69717a33440bcb9e2cc5a2652309a4ed20f' }
            )
        }
        'sqlite' {
            $repository = 'ericsink/SQLitePCL.raw'; $license = 'Apache-2.0'
            $files = @(
                @{ name = 'LICENSE.TXT'; sha256 = 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30' },
                @{ name = 'NOTICE.TXT'; sha256 = '485b276b3d2bfaa26df348e1e5c84df3648981e09b88531a6a53006f0705c24b' }
            )
        }
        'sqlclient' {
            $repository = 'dotnet/sqlclient'
            $files = @(
                @{ name = 'LICENSE'; sha256 = '9fa73cb72fb654d029c9214f0e3eec32c301a0c23be71b50fe3910e61553fa34' },
                @{ name = 'NOTICE.txt'; sha256 = 'db4e07b72af7b58c5a6cd39762fe757e7db7f9af4e67e8d6ecc05731dd7ff66c' }
            )
        }
        'efcore' {
            $repository = 'dotnet/dotnet'
            $files = @(@{ name = 'src/efcore/LICENSE.txt'; sha256 = 'ae48df11a335dc1a615f4f938b69cba73bcf4485c4f97af49b38efb0f216353b' })
        }
        'runtime' {
            $repository = 'dotnet/dotnet'
            $files = @(
                @{ name = 'src/runtime/LICENSE.TXT'; sha256 = 'cfc21f5e8bd655ae997eec916138b707b1d290b83272c02a95c9f821b8c87310' },
                @{ name = 'src/runtime/THIRD-PARTY-NOTICES.TXT'; sha256 = '66f1d4e44973185519bb4aa8a9718eb22fc7af2cc532e3ae9cfc4c127ee7fc54' }
            )
        }
        'identity' {
            $repository = 'AzureAD/azure-activedirectory-identitymodel-extensions-for-dotnet'
            $files = @(
                @{ name = 'LICENSE.txt'; sha256 = 'cba03f5387b05405e56b688376421acae396136af4b5116738dc6e5160f87ddd' },
                @{ name = 'NOTICE.html'; sha256 = 'd9f0289a2c38b4eedf5f22a045b6b37212d0989afb5f416a5f9ace59958136f7' },
                @{ name = 'ThirdPartyNotice.txt'; sha256 = '8d53e3a82ef34420b78b856dc5199ebed5ad854fc586014526ac17224fbbbc5e' }
            )
        }
    }
    return @{ repository = $repository; revision = $revision; license = $license; files = $files }
}

function Get-ReviewedNoticeFiles($Spec) {
    # Keep original vendor license/attribution text in the ignored cache and release only.
    $cache = Join-Path $root (".tools\third-party-notices\$($Spec.repository)\$($Spec.revision)")
    New-Item -ItemType Directory -Force -Path $cache | Out-Null
    $result = @()
    foreach ($entry in $Spec.files) {
        $file = Join-Path $cache $entry.name.Replace('/', '__')
        $url = "https://raw.githubusercontent.com/$($Spec.repository)/$($Spec.revision)/$($entry.name)"
        if (!(Test-Path -LiteralPath $file)) {
            $temporary = "$file.$([guid]::NewGuid().ToString('N')).tmp"
            try {
                Invoke-WebRequest -Uri $url -OutFile $temporary -TimeoutSec 60
                if ((Get-Item -LiteralPath $temporary).Length -gt 131072 -or (Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash -ne $entry.sha256) {
                    throw "Official upstream notice checksum mismatch: $($Spec.repository)/$($entry.name)"
                }
                Move-Item -LiteralPath $temporary -Destination $file
            } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary } }
        }
        $item = Get-Item -LiteralPath $file
        if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -gt 131072 -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $entry.sha256) {
            throw "Cached upstream notice differs from its reviewed checksum: $($Spec.repository)/$($entry.name)"
        }
        $result += [ordered]@{ name = $entry.name; path = $file; url = $url; sha256 = $entry.sha256; sourceRevision = $Spec.revision }
    }
    return $result
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
    # npm's root package has an empty key, which older PowerShell JSON readers reject.
    $lockPackagesJson = & node -e "const fs=require('fs'); const lock=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); delete lock.packages['']; process.stdout.write(JSON.stringify(lock.packages));" (Join-Path $web 'package-lock.json')
    if ($LASTEXITCODE -ne 0) { throw 'Cannot read the browser dependency lockfile.' }
    $browserLock = $lockPackagesJson | ConvertFrom-Json
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
        $lockedPackage = $browserLock.PSObject.Properties[$lockPath].Value
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
    $reviewedNotices = @{}
    foreach ($property in $deps.libraries.PSObject.Properties) {
        $inventoryEntry = [ordered]@{ name = $property.Name; type = $property.Value.type; hash = $property.Value.sha512; noticeFiles = @(); license = $null; licenseType = $null; copyright = $null; licenseUrl = $null; repository = $null; repositoryCommit = $null; requiresLicenseReview = $false }
        if ($property.Value.type -eq 'package') {
            $packageDirectory = Join-Path $env:NUGET_PACKAGES $property.Value.path
            if (Test-Path -LiteralPath $packageDirectory) {
                $nuspec = Get-ChildItem -LiteralPath $packageDirectory -File -Filter '*.nuspec' | Select-Object -First 1
                if ($nuspec) {
                    $packageXml = New-Object System.Xml.XmlDocument
                    $packageXml.XmlResolver = $null
                    $packageXml.Load($nuspec.FullName)
                    $metadata = $packageXml.SelectSingleNode('/*[local-name()="package"]/*[local-name()="metadata"]')
                    $license = $metadata.SelectSingleNode('*[local-name()="license"]')
                    if ($license) { $inventoryEntry.license = $license.InnerText; $inventoryEntry.licenseType = $license.GetAttribute('type') }
                    $copyright = $metadata.SelectSingleNode('*[local-name()="copyright"]')
                    if ($copyright) { $inventoryEntry.copyright = $copyright.InnerText }
                    $licenseUrl = $metadata.SelectSingleNode('*[local-name()="licenseUrl"]')
                    if ($licenseUrl) { $inventoryEntry.licenseUrl = $licenseUrl.InnerText }
                    $repository = $metadata.SelectSingleNode('*[local-name()="repository"]')
                    if ($repository) { $inventoryEntry.repository = $repository.GetAttribute('url'); $inventoryEntry.repositoryCommit = $repository.GetAttribute('commit') }
                }
                $packageNotices = @(Get-ChildItem -LiteralPath $packageDirectory -File -Recurse | Where-Object { $_.Name -match '^(LICENSE|LICENCE|NOTICE|ThirdPartyNotices)(\.|$)' })
                foreach ($notice in $packageNotices) {
                    $relative = $notice.FullName.Substring($packageDirectory.Length + 1)
                    $destination = Join-Path $notices (Join-Path $property.Name.Replace('/', '\') $relative)
                    New-Item -ItemType Directory -Force -Path (Split-Path $destination -Parent) | Out-Null
                    Copy-Item -LiteralPath $notice.FullName -Destination $destination
                    $inventoryEntry.noticeFiles += $destination.Substring($notices.Length + 1).Replace('\', '/')
                }
            }
            $noticeSpec = Get-ReviewedPackageNoticeSpec $property.Name
            if ($noticeSpec) {
                $licenseMatches = if ($noticeSpec.licenseDeclarationAbsent) { !$inventoryEntry.licenseType -and !$inventoryEntry.license } else { $inventoryEntry.licenseType -eq 'expression' -and $inventoryEntry.license -eq $noticeSpec.license }
                if (!$licenseMatches -or
                    ($inventoryEntry.repository -and $inventoryEntry.repository -ne "https://github.com/$($noticeSpec.repository)") -or
                    ($inventoryEntry.repositoryCommit -and $inventoryEntry.repositoryCommit -ne $noticeSpec.revision)) {
                    throw "Package metadata differs from its reviewed notice supplement: $($property.Name)"
                }
                $cacheKey = "$($noticeSpec.repository)/$($noticeSpec.revision)"
                $inventoryEntry.reviewedLicense = $noticeSpec.license
                if ($noticeSpec.sourceAvailability) {
                    $relative = Join-Path $property.Name.Replace('/', '\') 'SOURCE-AVAILABILITY.txt'
                    $destination = Join-Path $notices $relative
                    New-Item -ItemType Directory -Force -Path (Split-Path $destination -Parent) | Out-Null
                    @("Source code for the unmodified libraries distributed in $($property.Name) is available under $($noticeSpec.license) at:") + $noticeSpec.sourceAvailability | Set-Content -LiteralPath $destination -Encoding utf8
                    $inventoryEntry.sourceAvailability = $noticeSpec.sourceAvailability
                    $inventoryEntry.noticeFiles += $relative.Replace('\', '/')
                }
                if (!$reviewedNotices.ContainsKey($cacheKey)) { $reviewedNotices[$cacheKey] = @(Get-ReviewedNoticeFiles $noticeSpec) }
                $inventoryEntry.reviewedNoticeSources = @()
                foreach ($notice in $reviewedNotices[$cacheKey]) {
                    $relative = Join-Path $property.Name.Replace('/', '\') (Join-Path 'upstream' $notice.name.Replace('/', '\'))
                    $destination = Join-Path $notices $relative
                    New-Item -ItemType Directory -Force -Path (Split-Path $destination -Parent) | Out-Null
                    Copy-Item -LiteralPath $notice.path -Destination $destination
                    $inventoryEntry.noticeFiles += $relative.Replace('\', '/')
                    $inventoryEntry.reviewedNoticeSources += [ordered]@{ url = $notice.url; sha256 = $notice.sha256; sourceRevision = $notice.sourceRevision }
                }
            }
            $inventoryEntry.requiresLicenseReview = $inventoryEntry.noticeFiles.Count -eq 0
        }
        $packages += $inventoryEntry
    }
    $packages | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $notices 'package-inventory.json') -Encoding utf8
    & node (Join-Path $PSScriptRoot 'write-sbom.mjs') $stage $sourceCommit
    if ($LASTEXITCODE -ne 0) { throw 'Cannot inventory the exact installer dependencies.' }
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
    # Inno Setup pads the textual version resource; the numeric parts below remain exact.
    $installerTextVersion = $installerVersion.FileVersion.Trim()
    if ($installerTextVersion -ne $version -and $installerTextVersion -ne $fileVersion) { throw 'Compiled installer version does not match the release version.' }
    if ((@($installerVersion.FileMajorPart, $installerVersion.FileMinorPart, $installerVersion.FileBuildPart, $installerVersion.FilePrivatePart) -join '.') -ne $fileVersion) { throw 'Compiled installer numeric file version does not match the release version.' }
    $hash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
    "$hash  $([IO.Path]::GetFileName($installer))" | Set-Content -LiteralPath "$installer.sha256" -Encoding ascii
    [ordered]@{ installer = $installer; size = (Get-Item -LiteralPath $installer).Length; sha256 = $hash; payloadFileCount = $manifestFiles.Count; version = $version; fileVersion = $fileVersion; sourceCommit = $sourceCommit; sourceDirty = $false; browser = $provenance.browser; stage = $stage; compiler = $CompilerPath; unsigned = $true } | ConvertTo-Json -Depth 6 | Tee-Object -FilePath (Join-Path $output 'build-result.json')
} finally { Pop-Location }
