[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$outputDirectory = Join-Path (Split-Path $PSScriptRoot -Parent) 'examples\assets'
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
$bitmap = [System.Drawing.Bitmap]::new(960, 440)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.ColorTranslator]::FromHtml('#f2f5fa'))
$ink = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#202735'))
$muted = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#5e697b'))
$blue = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#3766d6'))
$pale = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#dfe9ff'))
$steel = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#c4cfde'))
$white = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
$outline = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml('#8393aa'), 3)
$titleFont = [System.Drawing.Font]::new('Segoe UI', 24, [System.Drawing.FontStyle]::Bold)
$labelFont = [System.Drawing.Font]::new('Segoe UI', 13)
try {
    $graphics.DrawString('ASSEMBLY CELL', $titleFont, $ink, 36, 24)
    $graphics.DrawString('Local equipment illustration', $labelFont, $muted, 38, 72)
    $graphics.FillRectangle($steel, 58, 278, 824, 30)
    $graphics.DrawRectangle($outline, 58, 278, 824, 30)
    foreach ($x in @(90, 170, 250, 330, 410, 490, 570, 650, 730, 810)) {
        $graphics.FillEllipse($white, $x, 282, 22, 22)
        $graphics.DrawEllipse($outline, $x, 282, 22, 22)
    }
    $graphics.FillRectangle($ink, 100, 310, 18, 66)
    $graphics.FillRectangle($ink, 804, 310, 18, 66)
    $graphics.FillRectangle($pale, 333, 127, 286, 148)
    $graphics.DrawRectangle($outline, 333, 127, 286, 148)
    $graphics.FillRectangle($blue, 346, 140, 260, 28)
    $graphics.FillRectangle($white, 364, 185, 162, 62)
    $graphics.DrawRectangle($outline, 364, 185, 162, 62)
    $graphics.FillRectangle($steel, 410, 173, 72, 19)
    $graphics.FillEllipse($blue, 548, 191, 22, 22)
    $graphics.FillEllipse($muted, 548, 229, 22, 22)
    foreach ($x in @(148, 704)) {
        $graphics.FillRectangle($blue, $x, 228, 66, 47)
        $graphics.FillRectangle($pale, $x + 8, 238, 50, 10)
    }
    $graphics.DrawString('INFEED', $labelFont, $muted, 133, 388)
    $graphics.DrawString('WORKCENTER', $labelFont, $muted, 405, 388)
    $graphics.DrawString('OUTFEED', $labelFont, $muted, 680, 388)
    $path = Join-Path $outputDirectory 'assembly-cell.png'
    $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Host "Example equipment image: $path"
} finally {
    foreach ($resource in @($graphics, $bitmap, $ink, $muted, $blue, $pale, $steel, $white, $outline, $titleFont, $labelFont)) { $resource.Dispose() }
}
