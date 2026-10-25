[CmdletBinding()]
param([Parameter(Mandatory)][string]$OutputDirectory)
# Draws the installer and shortcut icons from code so the repository holds no binary artwork.
# Runtime: the SparkStudio logo as is. Designer: a blueprint rendition of the same logo.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$sizes = @(16, 24, 32, 48, 64, 128, 256)
# Bolt from the 32-unit logo (apps/web/public/spark.svg): M18 4 8 18h7l-1 10 10-15h-7z
$bolt = @(@(18, 4), @(8, 18), @(15, 18), @(14, 28), @(24, 13), @(17, 13))

function New-RoundedRectangle([single]$Size, [single]$Radius) {
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $Radius * 2
    $path.AddArc(0, 0, $d, $d, 180, 90)
    $path.AddArc($Size - $d, 0, $d, $d, 270, 90)
    $path.AddArc($Size - $d, $Size - $d, $d, $d, 0, 90)
    $path.AddArc(0, $Size - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    return $path
}

function Get-BoltPoints([single]$Scale) {
    return [System.Drawing.PointF[]]@($bolt | ForEach-Object { New-Object System.Drawing.PointF(([single]$_[0] * $Scale), ([single]$_[1] * $Scale)) })
}

function New-Canvas([int]$Size) {
    $bitmap = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.Clear([System.Drawing.Color]::Transparent)
    return @($bitmap, $graphics)
}

function Draw-Runtime([int]$Size) {
    $bitmap, $graphics = New-Canvas $Size
    $scale = [single]($Size / 32.0)
    $frame = New-RoundedRectangle $Size (9 * $scale)
    $graphics.FillPath((New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#EF7739'))), $frame)
    $graphics.FillPolygon([System.Drawing.Brushes]::White, (Get-BoltPoints $scale))
    $graphics.Dispose()
    return $bitmap
}

function Draw-Designer([int]$Size) {
    $bitmap, $graphics = New-Canvas $Size
    $scale = [single]($Size / 32.0)
    $paper = [System.Drawing.ColorTranslator]::FromHtml('#1D4E9E')
    $line = [System.Drawing.ColorTranslator]::FromHtml('#E8F0FF')
    $frame = New-RoundedRectangle $Size (9 * $scale)
    $graphics.FillPath((New-Object System.Drawing.SolidBrush($paper)), $frame)
    $graphics.SetClip($frame)
    if ($Size -ge 48) {
        # Blueprint grid: a fine 2-unit grid with stronger 8-unit lines.
        $fine = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(46, 232, 240, 255), [single][Math]::Max(1, $scale * 0.12))
        $major = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(92, 232, 240, 255), [single][Math]::Max(1, $scale * 0.18))
        for ($u = 2; $u -lt 32; $u += 2) {
            $pen = if ($u % 8 -eq 0) { $major } else { $fine }
            $graphics.DrawLine($pen, [single]($u * $scale), 0, [single]($u * $scale), [single]$Size)
            $graphics.DrawLine($pen, 0, [single]($u * $scale), [single]$Size, [single]($u * $scale))
        }
    }
    if ($Size -ge 48) {
        # Construction details: extension lines, a dimension with ticks, and a compass arc.
        $thin = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(170, 232, 240, 255), [single]($scale * 0.3))
        $thin.DashStyle = [System.Drawing.Drawing2D.DashStyle]::Dash
        $graphics.DrawLine($thin, [single](8 * $scale), [single](18 * $scale), [single](8 * $scale), [single](30 * $scale))
        $graphics.DrawLine($thin, [single](24 * $scale), [single](13 * $scale), [single](24 * $scale), [single](30 * $scale))
        $dimension = New-Object System.Drawing.Pen($line, [single]($scale * 0.35))
        $graphics.DrawLine($dimension, [single](8 * $scale), [single](29.2 * $scale), [single](24 * $scale), [single](29.2 * $scale))
        foreach ($x in 8, 24) { $graphics.DrawLine($dimension, [single](($x - 0.8) * $scale), [single](30 * $scale), [single](($x + 0.8) * $scale), [single](28.4 * $scale)) }
        $graphics.DrawArc($thin, [single](-6 * $scale), [single](-6 * $scale), [single](20 * $scale), [single](20 * $scale), 0, 90)
        $graphics.FillEllipse((New-Object System.Drawing.SolidBrush($line)), [single](3.3 * $scale), [single](3.3 * $scale), [single](1.4 * $scale), [single](1.4 * $scale))
    }
    # The bolt drawn as an outline, the way a drafted part is shown.
    $stroke = [single][Math]::Max(1.4, $scale * $(if ($Size -le 32) { 1.9 } else { 1.25 }))
    $outline = New-Object System.Drawing.Pen($line, $stroke)
    $outline.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $graphics.DrawPolygon($outline, (Get-BoltPoints $scale))
    $graphics.ResetClip()
    $graphics.Dispose()
    return $bitmap
}

# Sizes below 256 are classic 32-bit DIB entries, which every Windows icon reader accepts; 256 is PNG.
function Get-DibBytes([System.Drawing.Bitmap]$Bitmap) {
    $size = $Bitmap.Width
    $rectangle = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
    $data = $Bitmap.LockBits($rectangle, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $pixels = New-Object byte[] ($data.Stride * $size)
    [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $pixels, 0, $pixels.Length)
    $Bitmap.UnlockBits($data)
    $stream = New-Object System.IO.MemoryStream
    $writer = New-Object System.IO.BinaryWriter($stream)
    $writer.Write([uint32]40); $writer.Write([int32]$size); $writer.Write([int32]($size * 2))
    $writer.Write([uint16]1); $writer.Write([uint16]32); $writer.Write([uint32]0)
    $writer.Write([uint32]($size * $size * 4)); $writer.Write([int32]0); $writer.Write([int32]0); $writer.Write([uint32]0); $writer.Write([uint32]0)
    for ($row = $size - 1; $row -ge 0; $row--) { $writer.Write($pixels, $row * $data.Stride, $size * 4) }
    $maskStride = [int]([Math]::Ceiling($size / 32.0) * 4)
    $writer.Write((New-Object byte[] ($maskStride * $size)))
    $writer.Flush()
    return $stream.ToArray()
}

function Write-Icon([string]$Path, [scriptblock]$Draw) {
    $images = foreach ($size in $sizes) {
        $bitmap = & $Draw $size
        if ($size -ge 256) {
            $stream = New-Object System.IO.MemoryStream
            $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
            $bytes = $stream.ToArray()
        } else {
            $bytes = Get-DibBytes $bitmap
        }
        $bitmap.Dispose()
        , @($size, $bytes)
    }
    $file = New-Object System.IO.MemoryStream
    $writer = New-Object System.IO.BinaryWriter($file)
    $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$images.Count)
    $offset = 6 + 16 * $images.Count
    foreach ($image in $images) {
        $dimension = if ($image[0] -ge 256) { 0 } else { $image[0] }
        $writer.Write([byte]$dimension); $writer.Write([byte]$dimension); $writer.Write([byte]0); $writer.Write([byte]0)
        $writer.Write([uint16]1); $writer.Write([uint16]32); $writer.Write([uint32]$image[1].Length); $writer.Write([uint32]$offset)
        $offset += $image[1].Length
    }
    foreach ($image in $images) { $writer.Write([byte[]]$image[1]) }
    $writer.Flush()
    [IO.File]::WriteAllBytes($Path, $file.ToArray())
    $writer.Dispose()
}

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
Write-Icon (Join-Path $OutputDirectory 'SparkStudio-Runtime.ico') ${function:Draw-Runtime}
Write-Icon (Join-Path $OutputDirectory 'SparkStudio-Designer.ico') ${function:Draw-Designer}
