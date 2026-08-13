# 激活 MSVC 编译环境后执行 tauri build（NSIS 打包）
# 版本已通过 test-vcvars.ps1 确认：VC 14.50.35717 / Win SDK 10.0.26100.0
$vc = "D:\BuildTools\VC\Tools\MSVC\14.50.35717"
$sdk = "C:\Program Files (x86)\Windows Kits\10"
$sdkVer = "10.0.26100.0"

$env:PATH = "$vc\bin\Hostx64\x64;$env:USERPROFILE\.cargo\bin;$env:PATH"
$env:LIB = "$vc\lib\x64;$sdk\lib\$sdkVer\ucrt\x64;$sdk\lib\$sdkVer\um\x64"
$env:INCLUDE = "$vc\include;$sdk\Include\$sdkVer\ucrt;$sdk\Include\$sdkVer\um;$sdk\Include\$sdkVer\shared"

$linkCheck = Get-Command link.exe -ErrorAction SilentlyContinue
Write-Output "link.exe -> $($linkCheck.Source)"
if (-not $linkCheck) {
  Write-Output "ERROR: link.exe not found after env setup"
  exit 1
}

Push-Location d:\miniboard
node C:\Users\asus\AppData\Roaming\npm\node_modules\@tauri-apps\cli\tauri.js build --bundles nsis 2>&1 | Tee-Object -FilePath d:\miniboard\tauri-build.log
$code = $LASTEXITCODE
Pop-Location
exit $code
