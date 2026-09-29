[CmdletBinding()]
param()
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

Install-Archive 'https://builds.dotnet.microsoft.com/dotnet/Sdk/10.0.401/dotnet-sdk-10.0.401-win-x64.zip' 'dotnet-sdk.zip' 'SHA512' '24b670ad3d923bfcf47df6c3b034152398b42f6dbc388e10d783aee1cfb5e5817d399fc0ae2a12cfa822a55e61d34830ccb15c50ef6efee437ab874bb7c79430' (Join-Path $root '.tools\dotnet') (Join-Path $root '.tools\dotnet\dotnet.exe')
Install-Archive 'https://www.python.org/ftp/python/3.14.7/python-3.14.7-embed-amd64.zip' 'python.zip' 'SHA256' 'd297e5ff019966817ad8502465176139f2d3d840fa4ed84b13bed399a6ab1f15' (Join-Path $root 'runtimes\python\windows-x64') (Join-Path $root 'runtimes\python\windows-x64\python.exe')
Write-Host 'Workspace .NET 10 SDK and Python 3 are ready. No system .NET installation is required.'
