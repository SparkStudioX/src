[CmdletBinding()]
param(
    [ValidateSet(5091)][int]$Port = 5091,
    [string]$ExpectedVersion = '0.2.0-preview.8',
    [string]$BuildResultPath,
    [string]$WorkshopDirectory
)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
if (!$BuildResultPath) { $BuildResultPath = Join-Path $root 'artifacts\installer\build-result.json' }
$BuildResultPath = [IO.Path]::GetFullPath($BuildResultPath)
$build = Get-Content -LiteralPath $BuildResultPath -Raw | ConvertFrom-Json
$installer = [IO.Path]::GetFullPath($build.installer)
$artifactRoot = (Join-Path $root 'artifacts') + [IO.Path]::DirectorySeparatorChar
if (!$installer.StartsWith($artifactRoot, [StringComparison]::OrdinalIgnoreCase) -or !$BuildResultPath.StartsWith($artifactRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Verify installer metadata and binary generated under this checkout artifacts directory.' }
if ($build.version -ne $ExpectedVersion -or $build.sourceDirty -ne $false -or $build.sourceCommit -notmatch '^[a-f0-9]{40}$') { throw 'Build metadata must identify the expected version and a clean source commit.' }
if ($build.sha256 -notmatch '^[a-f0-9]{64}$' -or (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash -ne $build.sha256) { throw 'Installer hash differs from build-result.json.' }
$node = (Get-Command node -ErrorAction Stop).Source
$testRoot = Join-Path $root ('.data\installer-verification-' + [guid]::NewGuid().ToString('N'))
$program = Join-Path $testRoot 'app'
$data = Join-Path $testRoot 'data'
$authFile = Join-Path $testRoot 'test-accounts.json'
$process = $null
$savedEnvironment = @{}
$checks = [Collections.Generic.List[object]]::new()
$sharedAuth = Join-Path $root '.data\test-evidence\security-test-accounts.json'
$sharedAuthHash = if (Test-Path -LiteralPath $sharedAuth) { (Get-FileHash -LiteralPath $sharedAuth -Algorithm SHA256).Hash } else { $null }

function WindowsIntegrationSnapshot {
    $registry = @(
        'HKLM:\SOFTWARE\SparkStudio\Installer',
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{C85DA4EA-0382-4B12-943A-CE73A1772FD8}_is1',
        'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\{C85DA4EA-0382-4B12-943A-CE73A1772FD8}_is1'
    ) | ForEach-Object {
        $values = [ordered]@{}
        if (Test-Path -LiteralPath $_) {
            foreach ($property in ((Get-ItemProperty -LiteralPath $_).PSObject.Properties | Where-Object Name -notlike 'PS*' | Sort-Object Name)) { $values[$property.Name] = $property.Value }
        }
        [ordered]@{ path = $_; exists = Test-Path -LiteralPath $_; values = $values }
    }
    $shortcuts = @(
        (Join-Path ([Environment]::GetFolderPath('CommonPrograms')) 'SparkStudio'),
        (Join-Path ([Environment]::GetFolderPath('Programs')) 'SparkStudio'),
        (Join-Path ([Environment]::GetFolderPath('CommonDesktopDirectory')) 'SparkStudio Designer.lnk'),
        (Join-Path ([Environment]::GetFolderPath('CommonDesktopDirectory')) 'SparkStudio Runtime.lnk'),
        (Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'SparkStudio Designer.lnk'),
        (Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'SparkStudio Runtime.lnk')
    ) | ForEach-Object {
        $files = if (Test-Path -LiteralPath $_) { @(Get-ChildItem -LiteralPath $_ -File -Recurse | Sort-Object FullName | ForEach-Object { [ordered]@{ path = $_.FullName; sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash } }) } else { @() }
        [ordered]@{ path = $_; exists = Test-Path -LiteralPath $_; files = $files }
    }
    $service = Get-CimInstance Win32_Service -Filter "Name='SparkStudio'" -ErrorAction Stop | Select-Object Name, PathName, StartName, StartMode, State, ProcessId
    [ordered]@{ registry = @($registry); shortcuts = @($shortcuts); service = $service } | ConvertTo-Json -Depth 10 -Compress
}

function NodeCheck([string]$Name, [string[]]$Arguments) {
    $started = [DateTime]::UtcNow
    $log = Join-Path $testRoot "$Name.log"
    & $node @Arguments 2>&1 | Tee-Object -FilePath $log | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "Installer verification '$Name' failed. See its isolated log: $log" }
    $checks.Add([ordered]@{ name = $Name; passed = $true; seconds = [Math]::Round(([DateTime]::UtcNow - $started).TotalSeconds, 2); log = $log })
}

# Never stop, reuse or modify an existing gateway occupying the isolated test port.
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
$listener.Server.ExclusiveAddressUse = $true
try { $listener.Start() } finally { $listener.Stop() }
$beforeIntegration = WindowsIntegrationSnapshot
New-Item -ItemType Directory -Path $testRoot | Out-Null
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $testRoot /inheritance:r /grant:r ('{0}:(OI)(CI)F' -f $identity) '*S-1-5-18:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not restrict the disposable credentials/data directory.' }
Push-Location $root
try {
    $extraction = Start-Process -FilePath $installer -ArgumentList @('/PORTABLE=1', '/CURRENTUSER', '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', ('/DIR="{0}"' -f $program), ('/LOG="{0}"' -f (Join-Path $testRoot 'extract.log'))) -WindowStyle Hidden -Wait -PassThru
    if ($extraction.ExitCode -ne 0) { throw "Installer extraction failed ($($extraction.ExitCode)). See $testRoot\extract.log" }
    $manifest = Get-Content -LiteralPath (Join-Path $program 'package-manifest.json') -Raw | ConvertFrom-Json
    if ($manifest.product -ne 'SparkStudio' -or $manifest.version -ne $ExpectedVersion -or $manifest.sourceCommit -ne $build.sourceCommit -or $manifest.sourceDirty -ne $false) { throw 'Extracted product/version/source provenance differs from build metadata.' }
    $indexed = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in $manifest.files) {
        if ($entry.path -notmatch '^[^:\\]+$' -or $entry.path.StartsWith('/') -or @($entry.path.Split('/') | Where-Object { $_ -in @('', '.', '..') }).Count -gt 0 -or !$indexed.Add($entry.path)) { throw 'Manifest contains a duplicate or unsafe payload path.' }
        $file = [IO.Path]::GetFullPath((Join-Path $program $entry.path))
        if (!$file.StartsWith($program + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Manifest path escaped extraction directory.' }
        $item = Get-Item -LiteralPath $file
        if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $entry.sha256 -notmatch '^[a-f0-9]{64}$' -or $item.Length -ne $entry.size -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $entry.sha256) { throw "Extracted file did not match manifest: $($entry.path)" }
    }
    foreach ($item in Get-ChildItem -LiteralPath $program -Recurse -Force) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Extracted payload contains a reparse point.' }
        if (!$item.PSIsContainer) {
            $relative = $item.FullName.Substring($program.Length + 1).Replace('\', '/')
            if ($relative -ne 'package-manifest.json' -and !$indexed.Contains($relative)) { throw "Unlisted file in extracted payload: $relative" }
        }
    }
    if ($manifest.files.Count -ne $build.payloadFileCount -or $manifest.browser.entry -ne $build.browser.entry -or $manifest.browser.sha256 -ne $build.browser.sha256) { throw 'Extracted file count/browser provenance differs from build metadata.' }
    if ((WindowsIntegrationSnapshot) -ne $beforeIntegration) { throw 'Portable extraction changed Windows service, registration or shortcut state.' }
    Write-Host "PASS portable extraction: $($manifest.files.Count) exact file hashes, clean source/version provenance, no Windows integration changes."
    # The extracted application gets no configured host SDK/Python or inherited listener override.
    $keys = @('PATH', 'DOTNET_ROOT', 'DOTNET_ROOT_X64', 'SPARKSTUDIO_DATA_DIR', 'SPARKSTUDIO_PYTHON', 'SPARKSTUDIO_TEST_AUTH_FILE', 'SPARKSTUDIO_DEPLOYMENT_DISABLE', 'Python__Executable', 'URLS')
    $keys += @(Get-ChildItem Env: | Where-Object { $_.Name -match '^(ASPNETCORE_|DOTNET_|SPARKSTUDIO_|Kestrel__)' } | Select-Object -ExpandProperty Name)
    foreach ($key in ($keys | Select-Object -Unique)) {
        if ($savedEnvironment.ContainsKey($key)) { continue }
        $savedEnvironment[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
        Remove-Item -LiteralPath "Env:$key" -ErrorAction SilentlyContinue
    }
    $env:PATH = "$env:SystemRoot\System32;$env:SystemRoot"
    $env:DOTNET_ROOT = Join-Path $testRoot 'no-installed-dotnet'
    $env:DOTNET_ROOT_X64 = $env:DOTNET_ROOT
    & (Join-Path $program 'SparkStudio.ServiceHelper.exe') --action self-test
    if ($LASTEXITCODE -ne 0) { throw 'Extracted helper guard checks failed.' }
    $process = Start-Process -FilePath (Join-Path $program 'SparkStudio.Gateway.exe') -ArgumentList @('--contentRoot', ('"{0}"' -f $program), '--DataDirectory', ('"{0}"' -f $data), '--urls', "http://127.0.0.1:$Port") -WorkingDirectory $program -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $testRoot 'gateway.stdout.log') -RedirectStandardError (Join-Path $testRoot 'gateway.stderr.log')
    $ready = $false
    for ($attempt = 0; $attempt -lt 100; $attempt++) {
        if ($process.HasExited) { throw 'Extracted gateway exited before startup. Check its isolated logs.' }
        try {
            $session = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/auth/session?audience=engineering" -TimeoutSec 2
            if ($session.setupRequired -and (Test-Path -LiteralPath (Join-Path $data 'security\setup-code.txt'))) { $ready = $true; break }
        } catch { }
        Start-Sleep -Milliseconds 200
    }
    if (!$ready) { throw 'Extracted self-contained gateway did not reach fresh local setup.' }
    $modules = @($process.Modules | Where-Object { $_.ModuleName -in @('coreclr.dll', 'hostfxr.dll') })
    if ($modules.Count -ne 2 -or @($modules | Where-Object { !$_.FileName.StartsWith($program + '\', [StringComparison]::OrdinalIgnoreCase) }).Count -gt 0) { throw 'The gateway did not load its .NET runtime entirely from the extracted package.' }
    # Exercise the actual installer poll before setup or authentication, against this exact process.
    $probeStarted = [DateTime]::UtcNow
    $probeLog = Join-Path $testRoot 'installer-readiness-probe.log'
    & (Join-Path $program 'SparkStudio.ServiceHelper.exe') --action probe --install-dir $program --port $Port --process-id $process.Id 2>&1 | Tee-Object -FilePath $probeLog | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'The installer readiness probe failed before gateway setup. See the isolated probe log.' }
    $checks.Add([ordered]@{ name = 'installer-readiness-probe'; passed = $true; seconds = [Math]::Round(([DateTime]::UtcNow - $probeStarted).TotalSeconds, 2); log = $probeLog })
    NodeCheck 'installer-auth-python' @((Join-Path $PSScriptRoot 'test-installer-auth.mjs'), $testRoot, [string]$process.Id)
    $env:SPARKSTUDIO_TEST_AUTH_FILE = $authFile
    # Node's --import treats a Windows drive-qualified path as a URL scheme.
    # The verifier runs from $root, so use a portable relative module specifier.
    $preloader = './tools/test-auth-session.mjs'
    NodeCheck 'gateway-smoke' @('--import', $preloader, (Join-Path $PSScriptRoot 'test-gateway.mjs'), "http://127.0.0.1:$Port", '--sse')
    NodeCheck 'assets-popups' @('--import', $preloader, (Join-Path $PSScriptRoot 'test-assets-popups.mjs'), "http://127.0.0.1:$Port")
    NodeCheck 'deployment-settings' @((Join-Path $PSScriptRoot 'test-deployment-settings.mjs'))
    NodeCheck 'connection-operations' @((Join-Path $PSScriptRoot 'test-gateway-connections.mjs'))
    NodeCheck 'query-cancellation' @('--import', $preloader, (Join-Path $PSScriptRoot 'test-query-cancellation.mjs'), '--api')
    if ($WorkshopDirectory) { NodeCheck 'workshop-roundtrip' @('--import', $preloader, (Join-Path $PSScriptRoot 'test-workshop-packages.mjs'), $WorkshopDirectory) }

    $indexHtml = (Invoke-WebRequest -Uri "http://127.0.0.1:$Port/").Content
    $asset = [regex]::Match($indexHtml, '/assets/index-[^" ]+\.js').Value
    if (!$asset -or $asset -ne $build.browser.entry) { throw 'Served browser entry differs from installer provenance.' }
    $download = Join-Path $testRoot 'served-browser.js'
    Invoke-WebRequest -Uri "http://127.0.0.1:$Port$asset" -OutFile $download
    $assetHash = (Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash.ToLowerInvariant()
    $expected = @($manifest.files | Where-Object path -eq ('wwwroot' + $asset))
    if ($expected.Count -ne 1 -or $assetHash -ne $expected[0].sha256 -or $assetHash -ne $build.browser.sha256) { throw 'Served browser bytes do not match the installer manifest.' }
    if ((WindowsIntegrationSnapshot) -ne $beforeIntegration) { throw 'Installer verification changed Windows integration state.' }
    $currentSharedAuthHash = if (Test-Path -LiteralPath $sharedAuth) { (Get-FileHash -LiteralPath $sharedAuth -Algorithm SHA256).Hash } else { $null }
    if ($currentSharedAuthHash -ne $sharedAuthHash) { throw 'Installer tests modified the existing isolated test credentials file.' }
    $python = Get-Content -LiteralPath (Join-Path $testRoot 'auth-python-verification.json') -Raw | ConvertFrom-Json
    $report = [ordered]@{ version = $ExpectedVersion; sourceCommit = $build.sourceCommit; installerSha256 = $build.sha256; extractedFileHashes = $manifest.files.Count; checks = $checks.ToArray(); bundledDotnetModulesVerified = $true; python = $python; browser = @{ entry = $asset; sha256 = $assetHash }; workshopRoundtripTested = [bool]$WorkshopDirectory; noWindowsIntegration = $true; serviceInstallationTested = $false; upgradeUninstallTested = $false; sharedTestCredentialsUnchanged = $true; fixture = $testRoot; verifiedAtUtc = [DateTime]::UtcNow.ToString('o') }
    $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $testRoot 'verification-result.json') -Encoding utf8
    $report | ConvertTo-Json -Depth 8 | Tee-Object -FilePath (Join-Path (Split-Path $BuildResultPath -Parent) 'verification-result.json')
} finally {
    if ($process -and !$process.HasExited) { $process.Kill(); $process.WaitForExit(10000) | Out-Null }
    foreach ($key in $savedEnvironment.Keys) {
        if ($null -eq $savedEnvironment[$key]) { Remove-Item -LiteralPath "Env:$key" -ErrorAction SilentlyContinue }
        else { [Environment]::SetEnvironmentVariable($key, $savedEnvironment[$key], 'Process') }
    }
    Pop-Location
}
