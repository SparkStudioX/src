[CmdletBinding()]
param([ValidateSet(5091)][int]$Port = 5091)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$installer = Join-Path $root 'artifacts\installer\SparkStudio-Setup-0.1.0-windows-x64-unsigned.exe'
$testRoot = Join-Path $root ('.data\installer-verification-' + [guid]::NewGuid().ToString('N'))
$program = Join-Path $testRoot 'app'
$data = Join-Path $testRoot 'data'
$process = $null
$savedEnvironment = @{}
$registryPaths = @(
    'HKLM:\SOFTWARE\SparkStudio\Installer',
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{C85DA4EA-0382-4B12-943A-CE73A1772FD8}_is1',
    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{C85DA4EA-0382-4B12-943A-CE73A1772FD8}_is1'
)
$beforeRegistry = @($registryPaths | ForEach-Object { Test-Path -LiteralPath $_ })
$beforeService = [bool](Get-Service -Name SparkStudio -ErrorAction SilentlyContinue)
$shortcutDirectories = @(
    (Join-Path ([Environment]::GetFolderPath('CommonPrograms')) 'SparkStudio'),
    (Join-Path ([Environment]::GetFolderPath('Programs')) 'SparkStudio')
)
$beforeShortcuts = @($shortcutDirectories | ForEach-Object { Test-Path -LiteralPath $_ })
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
$listener.Server.ExclusiveAddressUse = $true
try { $listener.Start() } finally { $listener.Stop() }
New-Item -ItemType Directory -Path $testRoot | Out-Null
try {
    $extraction = Start-Process -FilePath $installer -ArgumentList @('/PORTABLE=1', '/CURRENTUSER', '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', ('/DIR="{0}"' -f $program), ('/LOG="{0}"' -f (Join-Path $testRoot 'extract.log'))) -WindowStyle Hidden -Wait -PassThru
    if ($extraction.ExitCode -ne 0) { throw "Installer extraction failed ($($extraction.ExitCode)). See $testRoot\extract.log" }
    $manifest = Get-Content -LiteralPath (Join-Path $program 'package-manifest.json') -Raw | ConvertFrom-Json
    foreach ($entry in $manifest.files) {
        $path = [IO.Path]::GetFullPath((Join-Path $program $entry.path))
        if (!$path.StartsWith($program + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Manifest path escaped extraction directory.' }
        if ((Get-Item -LiteralPath $path).Length -ne $entry.size -or (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $entry.sha256) { throw "Extracted file did not match manifest: $($entry.path)" }
    }
    if (Test-Path -LiteralPath (Join-Path $program 'unins000.exe')) { throw 'Portable extraction unexpectedly created an uninstaller.' }
    for ($index = 0; $index -lt $registryPaths.Count; $index++) {
        if ((Test-Path -LiteralPath $registryPaths[$index]) -ne $beforeRegistry[$index]) { throw 'Portable extraction changed installation registration.' }
    }
    for ($index = 0; $index -lt $shortcutDirectories.Count; $index++) {
        if ((Test-Path -LiteralPath $shortcutDirectories[$index]) -ne $beforeShortcuts[$index]) { throw 'Portable extraction created Start menu shortcuts.' }
    }
    if ([bool](Get-Service -Name SparkStudio -ErrorAction SilentlyContinue) -ne $beforeService) { throw 'Portable extraction changed service presence.' }
    Write-Host "PASS extraction: $($manifest.files.Count) file hashes; no service, registration, shortcuts or uninstaller."
    & (Join-Path $program 'SparkStudio.ServiceHelper.exe') --action self-test
    if ($LASTEXITCODE -ne 0) { throw 'Extracted helper guard checks failed.' }
    foreach ($key in @('DOTNET_ROOT', 'DOTNET_ROOT_X64', 'SPARKSTUDIO_DATA_DIR', 'SPARKSTUDIO_PYTHON')) {
        $savedEnvironment[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
        Remove-Item -LiteralPath "Env:$key" -ErrorAction SilentlyContinue
    }
    $env:DOTNET_ROOT = Join-Path $testRoot 'no-installed-dotnet'
    $env:DOTNET_ROOT_X64 = $env:DOTNET_ROOT
    $process = Start-Process -FilePath (Join-Path $program 'SparkStudio.Gateway.exe') -ArgumentList @('--contentRoot', ('"{0}"' -f $program), '--DataDirectory', ('"{0}"' -f $data), '--urls', "http://127.0.0.1:$Port") -WorkingDirectory $program -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $testRoot 'gateway.stdout.log') -RedirectStandardError (Join-Path $testRoot 'gateway.stderr.log')
    $ready = $false
    for ($attempt = 0; $attempt -lt 100; $attempt++) {
        if ($process.HasExited) { throw 'Extracted gateway exited before startup. Check its stderr log.' }
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 2
            if ($health.pythonAvailable) { $ready = $true; break }
        } catch { }
        Start-Sleep -Milliseconds 200
    }
    if (!$ready) { throw 'Extracted self-contained gateway did not become ready.' }
    & node (Join-Path $PSScriptRoot 'test-gateway.mjs') "http://127.0.0.1:$Port" --sse
    if ($LASTEXITCODE -ne 0) { throw 'Extracted gateway smoke failed.' }
    & node (Join-Path $PSScriptRoot 'test-assets-popups.mjs') "http://127.0.0.1:$Port"
    if ($LASTEXITCODE -ne 0) { throw 'Extracted assets/popup smoke failed.' }
    $indexHtml = (Invoke-WebRequest -Uri "http://127.0.0.1:$Port/").Content
    $asset = [regex]::Match($indexHtml, '/assets/index-[^" ]+\.js').Value
    if (!$asset) { throw 'No browser JavaScript asset was served.' }
    $download = Join-Path $testRoot 'served-browser.js'
    Invoke-WebRequest -Uri "http://127.0.0.1:$Port$asset" -OutFile $download
    $assetHash = (Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash
    $expected = $manifest.files | Where-Object path -eq ('wwwroot' + $asset)
    if (!$expected -or $assetHash -ne $expected.sha256) { throw 'Served browser bundle does not match the installer manifest.' }
    $report = [ordered]@{ extractedFileHashes = $manifest.files.Count; helperChecks = 20; gatewayChecks = 19; assetPopupChecks = 12; dotnetRootAbsent = $true; asset = $asset; assetSha256 = $assetHash; noWindowsIntegration = $true; serviceInstallationTested = $false; fixture = $testRoot; verifiedAtUtc = [DateTime]::UtcNow.ToString('o') }
    $report | ConvertTo-Json | Tee-Object -FilePath (Join-Path $root 'artifacts\installer\verification-result.json')
} finally {
    if ($process -and !$process.HasExited) { Stop-Process -Id $process.Id; $process.WaitForExit(10000) | Out-Null }
    foreach ($key in $savedEnvironment.Keys) {
        if ($null -eq $savedEnvironment[$key]) { Remove-Item -LiteralPath "Env:$key" -ErrorAction SilentlyContinue }
        else { [Environment]::SetEnvironmentVariable($key, $savedEnvironment[$key], 'Process') }
    }
}
