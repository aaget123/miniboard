# 构建 Miniboard 桌面版（NSIS 安装包）
# 用法：powershell -ExecutionPolicy Bypass -File tools/build-tauri.ps1
# 环境变量覆盖（未设置时自动探测）：
#   MINIBOARD_MSVC  MSVC 工具链根（如 D:\BuildTools\VC\Tools\MSVC\14.50.35717）
#   MINIBOARD_SDK   Windows SDK 根（如 C:\Program Files (x86)\Windows Kits\10）

# 用 Continue 而非 Stop：PS 5.1 下外部命令（node/tauri CLI）写 stderr 的 Info 消息
# 在 Stop 模式下会被当作 NativeCommandError 终止脚本；throw 语句仍为终止错误，不受影响
$ErrorActionPreference = "Continue"
$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")

function Find-VcRoot {
  if ($env:MINIBOARD_MSVC -and (Test-Path $env:MINIBOARD_MSVC)) {
    return $env:MINIBOARD_MSVC
  }
  # vswhere 探测（Visual Studio / Build Tools 安装）
  $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
  if (Test-Path $vswhere) {
    $vsPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
    if ($vsPath) {
      $latest = Get-ChildItem (Join-Path $vsPath "VC\Tools\MSVC") -Directory -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending | Select-Object -First 1
      if ($latest) {
        return $latest.FullName
      }
    }
  }
  # 常见默认路径兜底
  $fallback = "D:\BuildTools\VC\Tools\MSVC"
  if (Test-Path $fallback) {
    $latest = Get-ChildItem $fallback -Directory | Sort-Object Name -Descending | Select-Object -First 1
    if ($latest) {
      return $latest.FullName
    }
  }
  throw "未找到 MSVC 工具链（VC\Tools\MSVC），请设置环境变量 MINIBOARD_MSVC"
}

function Find-SdkRoot {
  if ($env:MINIBOARD_SDK -and (Test-Path $env:MINIBOARD_SDK)) {
    return $env:MINIBOARD_SDK
  }
  $fallback = "C:\Program Files (x86)\Windows Kits\10"
  if (Test-Path $fallback) {
    return $fallback
  }
  throw "未找到 Windows SDK，请设置环境变量 MINIBOARD_SDK"
}

function Find-SdkVersion($sdkRoot) {
  # 取 Include 下最新的 SDK 版本（如 10.0.26100.0）
  $latest = Get-ChildItem (Join-Path $sdkRoot "Include") -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^\d+\.\d+\.\d+\.\d+$' } |
    Sort-Object Name -Descending | Select-Object -First 1
  if ($latest) {
    return $latest.Name
  }
  throw "SDK 目录下未找到版本目录（Include\10.x.x.x），请设置环境变量 MINIBOARD_SDK"
}

$vc = Find-VcRoot
$sdk = Find-SdkRoot
$sdkVer = Find-SdkVersion $sdk

$env:PATH = "$vc\bin\Hostx64\x64;$env:USERPROFILE\.cargo\bin;$env:PATH"
$env:LIB = "$vc\lib\x64;$sdk\lib\$sdkVer\ucrt\x64;$sdk\lib\$sdkVer\um\x64"
$env:INCLUDE = "$vc\include;$sdk\Include\$sdkVer\ucrt;$sdk\Include\$sdkVer\um;$sdk\Include\$sdkVer\shared"

Write-Output "MSVC     -> $vc"
Write-Output "WinSDK   -> $sdk ($sdkVer)"
$linkCheck = Get-Command link.exe -ErrorAction SilentlyContinue
Write-Output "link.exe -> $($linkCheck.Source)"
if (-not $linkCheck) {
  Write-Output "ERROR: link.exe not found after env setup"
  exit 1
}

# 优先使用项目本地 CLI，未安装时回退 npm 全局
$tauriCli = Join-Path $projectRoot "node_modules\@tauri-apps\cli\tauri.js"
if (-not (Test-Path $tauriCli)) {
  $tauriCli = Join-Path $env:APPDATA "npm\node_modules\@tauri-apps\cli\tauri.js"
}
if (-not (Test-Path $tauriCli)) {
  Write-Output "ERROR: 未找到 @tauri-apps/cli（先 npm install，或 npm i -g @tauri-apps/cli）"
  exit 1
}

Push-Location $projectRoot
try {
  node $tauriCli build --bundles nsis 2>&1 | Tee-Object -FilePath (Join-Path $projectRoot "tauri-build.log")
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
