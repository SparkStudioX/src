[CmdletBinding()]
param([switch]$PythonOnly)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$downloads = Join-Path $root '.tools\downloads'
New-Item -ItemType Directory -Force -Path $downloads | Out-Null

function Install-Archive($Url, $Name, $Algorithm, $Hash, $Destination, $CheckFile) {
    if (Test-Path -LiteralPath $CheckFile) { return }
    $archive = Join-Path $downloads $Name
    if (!(Test-Path -LiteralPath $archive)) { Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $archive }
    if ((Get-FileHash -LiteralPath $archive -Algorithm $Algorithm).Hash -ne $Hash) {
        throw "Checksum mismatch for $archive. Remove that file and retry."
    }
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    Expand-Archive -LiteralPath $archive -DestinationPath $Destination -Force
}

if (!$PythonOnly) { Install-Archive 'https://builds.dotnet.microsoft.com/dotnet/Sdk/10.0.402/dotnet-sdk-10.0.402-win-x64.zip' 'dotnet-sdk-10.0.402.zip' 'SHA512' 'ae4fd528cb7e9f6af6aaf7de36715a69f761f183744f1bb3025d19f5a92447090ec561410e46266c1d10a63781ed6f3de771760bc76c876d87daabc367b898cd' (Join-Path $root '.tools\dotnet') (Join-Path $root '.tools\dotnet\sdk\10.0.402\dotnet.dll') }
Install-Archive 'https://www.python.org/ftp/python/3.14.7/python-3.14.7-embed-amd64.zip' 'python.zip' 'SHA256' 'd297e5ff019966817ad8502465176139f2d3d840fa4ed84b13bed399a6ab1f15' (Join-Path $root 'runtimes\python\windows-x64') (Join-Path $root 'runtimes\python\windows-x64\python.exe')
if ($PythonOnly) { Write-Host 'Pinned Windows Python payload and its native runtime dependency are ready.' }
else { Write-Host 'Workspace .NET 10 SDK and Python 3 are ready. No system .NET installation is required.' }
