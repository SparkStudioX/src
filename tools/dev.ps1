[CmdletBinding()]
param(
    [switch]$NoBuild,
    [ValidateRange(1, 65535)][int]$Port = 5090,
    [switch]$Watch,
    [ValidateRange(1, 65535)][int]$BackendPort = 5092,
    [ValidateNotNullOrEmpty()][string]$DataDirectory = '.data/development'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
if ($Watch) {
    if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'Watch mode requires PowerShell 7 so its child process trees can be stopped reliably.' }
    if ($Port -eq $BackendPort) { throw 'Watch mode requires different browser and backend ports.' }
    $listeners = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
    foreach ($requestedPort in @($Port, $BackendPort)) {
        if ($listeners.Port -contains $requestedPort) { throw "Port $requestedPort is already in use. Stop the existing server or choose different -Port and -BackendPort values." }
    }
} elseif ($PSBoundParameters.ContainsKey('BackendPort')) {
    throw '-BackendPort is only used with -Watch.'
}
if (!$NoBuild) { & (Join-Path $PSScriptRoot 'build.ps1') }
$env:DOTNET_ROOT = Join-Path $root '.tools\dotnet'
$env:DOTNET_CLI_HOME = Join-Path $root '.tools'
$env:NUGET_PACKAGES = Join-Path $root '.tools\nuget'
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:SPARKSTUDIO_DATA_DIR = [System.IO.Path]::GetFullPath($(if ([System.IO.Path]::IsPathRooted($DataDirectory)) { $DataDirectory } else { Join-Path $root $DataDirectory }))
$env:ASPNETCORE_ENVIRONMENT = 'Development'
$assembly = Join-Path $root 'src\SparkStudio.Gateway\bin\Debug\net10.0\SparkStudio.Gateway.dll'
if (!(Test-Path -LiteralPath $assembly)) { throw 'Run tools/build.ps1 first.' }
$dotnet = Join-Path $env:DOTNET_ROOT 'dotnet.exe'
if (!(Test-Path -LiteralPath $dotnet)) { throw 'Run tools/bootstrap.ps1 to install the workspace .NET SDK.' }

if ($Watch) {
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $webRoot = Join-Path $root 'apps\web'
    $vite = Join-Path $webRoot 'node_modules\vite\bin\vite.js'
    if (!(Test-Path -LiteralPath $vite)) { throw 'Run tools/build.ps1 first to install browser dependencies.' }
    $projectFile = Join-Path $root 'src\SparkStudio.Gateway\SparkStudio.Gateway.csproj'
    $contentRoot = Join-Path $root 'src\SparkStudio.Gateway'
    $logRoot = Join-Path $root ('.data\dev-watch\' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
    $processes = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()
    $streams = [System.Collections.Generic.List[object]]::new()
    $watchEnvironment = @{
        SPARKSTUDIO_WEB_PORT = [string]$Port
        SPARKSTUDIO_GATEWAY_PORT = [string]$BackendPort
        DOTNET_WATCH_SUPPRESS_BROWSER_REFRESH = '1'
        DOTNET_WATCH_SUPPRESS_LAUNCH_BROWSER = '1'
        DOTNET_WATCH_RESTART_ON_RUDE_EDIT = '1'
        DOTNET_WATCH_SUPPRESS_EMOJIS = '1'
    }
    $originalEnvironment = @{}
    foreach ($name in $watchEnvironment.Keys) {
        $originalEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
        [Environment]::SetEnvironmentVariable($name, $watchEnvironment[$name], 'Process')
    }
    function Start-WatchedProcess([string]$Name, [string]$Executable, [string[]]$Arguments, [string]$WorkingDirectory) {
        $stdout = Join-Path $logRoot "$Name.stdout.log"
        $stderr = Join-Path $logRoot "$Name.stderr.log"
        # Start-Process joins ArgumentList into a command line; quote every argument as data.
        $quoted = $Arguments | ForEach-Object { '"' + $_.Replace('"', '\"') + '"' }
        $process = Start-Process -FilePath $Executable -ArgumentList $quoted -WorkingDirectory $WorkingDirectory -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
        $processes.Add($process)
        foreach ($file in @($stdout, $stderr)) {
            $stream = [System.IO.File]::Open($file, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
            $streams.Add(@{ Name = $Name; Reader = [System.IO.StreamReader]::new($stream) })
        }
        return $process
    }
    function Write-WatchOutput {
        foreach ($stream in $streams) {
            $text = $stream.Reader.ReadToEnd()
            if ($text.Length) { Write-Host "[$($stream.Name)] $($text.TrimEnd())" }
        }
    }
    try {
        $backend = Start-WatchedProcess 'gateway' $dotnet @('watch', '--project', $projectFile, '--no-hot-reload', 'run', '--no-launch-profile', '--no-restore', '--', '--urls', "http://127.0.0.1:$BackendPort", '--contentRoot', $contentRoot) $root
        $frontend = Start-WatchedProcess 'browser' $node @($vite) $webRoot
        Write-Host "SparkStudio watch: http://127.0.0.1:$Port"
        Write-Host "Gateway backend: http://127.0.0.1:$BackendPort (browser requests are proxied through $Port)"
        Write-Host 'Browser source changes refresh through Vite. Gateway source changes rebuild and restart through dotnet watch.'
        Write-Host "Development data: $env:SPARKSTUDIO_DATA_DIR"
        Write-Host "Logs: $logRoot"
        Write-Host 'Press Ctrl+C to stop both servers. Do not run another gateway against this data directory.'
        while ($true) {
            Write-WatchOutput
            $backend.Refresh()
            $frontend.Refresh()
            if ($backend.HasExited -or $frontend.HasExited) {
                Write-WatchOutput
                $ended = if ($backend.HasExited) { "Gateway watcher exited with code $($backend.ExitCode)." } else { "Browser watcher exited with code $($frontend.ExitCode)." }
                throw "$ended See $logRoot for startup or build diagnostics."
            }
            Start-Sleep -Milliseconds 350
        }
    } finally {
        foreach ($process in $processes) {
            try {
                $process.Refresh()
                if (!$process.HasExited) { $process.Kill($true); $null = $process.WaitForExit(5000) }
            } catch { Write-Warning "Could not stop watch process $($process.Id): $($_.Exception.Message)" }
            finally { $process.Dispose() }
        }
        foreach ($stream in $streams) { $stream.Reader.Dispose() }
        foreach ($name in $originalEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $originalEnvironment[$name], 'Process') }
    }
    return
}

Write-Host "SparkStudio: http://127.0.0.1:$Port"
& $dotnet $assembly --urls "http://127.0.0.1:$Port" --contentRoot (Join-Path $root 'src\SparkStudio.Gateway')
if ($LASTEXITCODE -ne 0) { throw "Gateway exited with code $LASTEXITCODE." }
