#Requires -RunAsAdministrator
# Run the copy in a published installation directory, from elevated PowerShell.
[CmdletBinding()]
param(
    [ValidateRange(1024, 65535)][int]$Port = 5090,
    [ValidateSet('local', 'network', 'keep')][string]$Access,
    [ValidateRange(1024, 65535)][int]$HttpsPort = 5443,
    [string]$Hostname,
    [ValidateSet('provided', 'self-signed')][string]$CertificateMode = 'provided',
    [string]$Certificate,
    [string]$PrivateKey
)
$ErrorActionPreference = 'Stop'
$helper = Join-Path $PSScriptRoot 'SparkStudio.ServiceHelper.exe'
if (!(Test-Path -LiteralPath $helper -PathType Leaf)) { throw 'Use the copy in the published Windows payload; the same service helper used by Setup is required.' }
if (!$Access) { $Access = if (Get-Service SparkStudio -ErrorAction SilentlyContinue) { 'keep' } else { 'local' } }
$options = @('--install-dir', $PSScriptRoot, '--port', $Port.ToString(), '--access', $Access, '--https-port', $HttpsPort.ToString(), '--certificate-mode', $CertificateMode)
if ($Hostname) { $options += @('--hostname', $Hostname) }
if ($Certificate) { $options += @('--certificate', $Certificate) }
if ($PrivateKey) { $options += @('--private-key', $PrivateKey) }
# The helper checks ownership, stops only the owned service, preserves its data,
# applies the same ACL/listener policy as Setup and verifies bundled-Python health.
& $helper --action preflight @options
if ($LASTEXITCODE -ne 0) { throw 'Service preflight failed; no service was changed.' }
& $helper --action prepare @options
if ($LASTEXITCODE -ne 0) { throw 'The owned service could not be prepared.' }
try {
    & $helper --action install @options
    if ($LASTEXITCODE -ne 0) { throw 'Service installation or readiness failed; inspect the helper diagnostics.' }
} catch {
    & $helper --action resume @options
    if ($LASTEXITCODE -ne 0) { Write-Warning 'The service could not be resumed. Existing gateway data is retained.' }
    throw
}
Write-Host "SparkStudio is ready at http://127.0.0.1:$Port. Gateway data: $env:ProgramData\SparkStudio."
if ($Access -eq 'network') { Write-Host "Network URL: https://${Hostname}:$HttpsPort. Configure client trust and the intended firewall rule separately." }
