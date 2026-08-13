# 生成 Miniboard 应用图标（1024x1024 PNG，供 tauri icon 转换）
param(
  [string]$OutPath = "d:\excalidraw\excalidraw-master\.miniboard-dev\src-tauri\icons\icon-source.png"
)
Add-Type -AssemblyName System.Drawing

$bmp = New-Object System.Drawing.Bitmap(1024, 1024, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::FromArgb(255, 30, 31, 34)) # 深色背景 #1e1f22

# 中央画笔笔迹（蓝色粗折线，圆头圆角）
$pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 79, 140, 255), 96)
$pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round

$pts = @(
  (New-Object System.Drawing.PointF(270, 720)),
  (New-Object System.Drawing.PointF(420, 360)),
  (New-Object System.Drawing.PointF(570, 620)),
  (New-Object System.Drawing.PointF(770, 280))
)
$g.DrawLines($pen, $pts)

# 收笔处的小圆点装饰（白色）
$dot = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 255, 255, 255))
$g.FillEllipse($dot, 710, 200, 120, 120)

$g.Dispose()
$bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "icon generated: $OutPath"
