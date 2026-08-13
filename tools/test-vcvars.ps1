# 调试：验证 vcvars64.bat 环境变量解析
$vcvars = cmd /c "call `"D:\BuildTools\VC\Auxiliary\Build\vcvars64.bat`" >nul 2>&1 && set"
Write-Output "total lines: $($vcvars.Count)"
$pathLine = $vcvars | Where-Object { $_ -match '^Path=' } | Select-Object -First 1
Write-Output "Path line found: $($null -ne $pathLine)"
if ($pathLine) { Write-Output ("Path head: " + $pathLine.Substring(0, [Math]::Min(200, $pathLine.Length))) }
$libLine = $vcvars | Where-Object { $_ -match '^LIB=' } | Select-Object -First 1
Write-Output "LIB line found: $($null -ne $libLine)"
if ($libLine) { Write-Output ("LIB head: " + $libLine.Substring(0, [Math]::Min(200, $libLine.Length))) }
$sdkLine = $vcvars | Where-Object { $_ -match '^WindowsSdkDir=' } | Select-Object -First 1
Write-Output "WindowsSdkDir: $($sdkLine -replace '^WindowsSdkDir=', '')"
