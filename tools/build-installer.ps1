[CmdletBinding()]
param([switch]$SkipHelperBuild, [string]$CompilerPath)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$published = Join-Path $root 'artifacts\windows-x64'
$output = Join-Path $root 'artifacts\installer'
$helper = Join-Path $root 'artifacts\installer-helper'
$compilerVersion = '7.1.0'
$compilerSha256 = '0362a383ed217d4c4239b5933866dd96d3eb2102737da92f80f6057a4b40df2f'

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
        & "$env:DOTNET_ROOT\dotnet.exe" publish installer/ServiceHelper/ServiceHelper.csproj -c Release -r win-x64 --self-contained true -o $helper --configfile NuGet.Config -p:NuGetLockFilePath=packages.win-x64.lock.json -p:RestoreLockedMode=true
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
        if ($relative -match '(^|\\)(data|\.data|gwbk|keyring|logs|pki|node_modules)(\\|$)' -or $file.Extension -in @('.pfx', '.p12', '.key', '.gwbk')) {
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
        @('.tools\dotnet\ThirdPartyNotices.txt', 'dotnet-ThirdPartyNotices.txt'),
        @('apps\web\node_modules\react\LICENSE', 'react-LICENSE.txt'),
        @('apps\web\node_modules\react-dom\LICENSE', 'react-dom-LICENSE.txt'),
        @('apps\web\node_modules\scheduler\LICENSE', 'scheduler-LICENSE.txt')
    )) { Copy-Item -LiteralPath (Join-Path $root $entry[0]) -Destination (Join-Path $notices $entry[1]) }
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
    $manifest = [ordered]@{ product = 'SparkStudio'; version = '0.1.0'; platform = 'windows-x64'; unsigned = $true; generatedAtUtc = [DateTime]::UtcNow.ToString('o'); files = $manifestFiles }
    $manifestPath = Join-Path $stage 'package-manifest.json'
    $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestPath -Encoding utf8
    Copy-Item -LiteralPath $manifestPath -Destination (Join-Path $output 'package-manifest.json') -Force
    & $CompilerPath '/Qp' ('/DPayloadDir=' + $stage) ('/DOutputFolder=' + $output) (Join-Path $root 'installer\SparkStudio.iss')
    if ($LASTEXITCODE -ne 0) { throw 'Inno Setup compilation failed.' }
    $installer = Join-Path $output 'SparkStudio-Setup-0.1.0-windows-x64-unsigned.exe'
    $hash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
    "$hash  $([IO.Path]::GetFileName($installer))" | Set-Content -LiteralPath "$installer.sha256" -Encoding ascii
    [ordered]@{ installer = $installer; size = (Get-Item -LiteralPath $installer).Length; sha256 = $hash; payloadFileCount = $manifestFiles.Count; stage = $stage; compiler = $CompilerPath; unsigned = $true } | ConvertTo-Json | Tee-Object -FilePath (Join-Path $output 'build-result.json')
} finally { Pop-Location }
