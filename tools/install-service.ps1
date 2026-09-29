# Run from the published directory in an elevated PowerShell session.
[CmdletBinding()]
param([string]$DataDirectory = "$env:ProgramData\SparkStudio", [ValidateRange(1, 65535)][int]$Port = 5090)
#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'
$exe = Join-Path $PSScriptRoot 'SparkStudio.Gateway.exe'
if (!(Test-Path -LiteralPath $exe)) { throw 'Use the copy of this script in artifacts/windows-x64 after publishing.' }
if (Get-Service -Name SparkStudio -ErrorAction SilentlyContinue) { throw 'SparkStudio service already exists. Stop and update it explicitly before reinstalling.' }
# Fail before service registration when the development gateway already owns this port.
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
try { $listener.Start() }
catch { throw "Cannot listen on 127.0.0.1:$Port. Stop the existing gateway or choose another -Port before installing the service." }
finally { $listener.Stop() }
$data = [IO.Path]::GetFullPath($DataDirectory)
New-Item -ItemType Directory -Force -Path $data | Out-Null
$command = '"{0}" --contentRoot "{1}" --DataDirectory "{2}" --urls http://127.0.0.1:{3}' -f $exe, $PSScriptRoot, $data, $Port
$created = $false
try {
    & sc.exe create SparkStudio binPath= $command start= auto obj= 'NT AUTHORITY\LocalService' DisplayName= 'SparkStudio Gateway'
    if ($LASTEXITCODE -ne 0) { throw 'Service creation failed.' }
    $created = $true
    & sc.exe sidtype SparkStudio unrestricted
    if ($LASTEXITCODE -ne 0) { throw 'Could not enable the service identity.' }
    & icacls.exe $data /grant 'NT SERVICE\SparkStudio:(OI)(CI)M'
    if ($LASTEXITCODE -ne 0) { throw 'Could not grant gateway access to its data folder.' }
    Start-Service SparkStudio
} catch {
    if ($created) {
        Stop-Service SparkStudio -ErrorAction SilentlyContinue
        & sc.exe delete SparkStudio
        if ($LASTEXITCODE -ne 0) { Write-Warning 'Installation failed and service cleanup was unsuccessful. Inspect the SparkStudio service before retrying.' }
    }
    throw
}
Write-Host "SparkStudio service is running on http://127.0.0.1:$Port. Configure connections under the service account; do not copy user-encrypted development credentials."
