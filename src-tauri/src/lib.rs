use serde_json::json;
use std::fs;
use std::path::Path;
use tauri::Manager;
use tauri_plugin_fs::FsExt;

/// 用户自定义数据目录配置文件名（位于 appDataDir 下，与数据本体分离）。
/// 前端每次启动通过 resolveDataDir() 读取；未配置时默认 appDataDir（兼容旧版路径）。
const DATA_DIR_CFG: &str = "data-dir.json";

/// 设置用户数据目录：创建目录、授权 fs scope、迁移旧数据（projects/*.json + custom-tools.json）、
/// 记录配置（appDataDir/data-dir.json）。前端在迁移成功后重载存储。
#[tauri::command]
fn set_data_dir(
  app: tauri::AppHandle,
  old_dir: String,
  new_dir: String,
) -> Result<(), String> {
  let new_root = Path::new(new_dir.trim());
  if new_root.as_os_str().is_empty() {
    return Err("目录不能为空".into());
  }
  // 1. 创建 projects 子目录
  fs::create_dir_all(new_root.join("projects"))
    .map_err(|e| format!("创建目录失败：{e}"))?;
  // 2. 迁移旧数据（目录不同时复制项目文件与自定义工具文件）
  let old_root = Path::new(old_dir.trim());
  if !old_root.as_os_str().is_empty() && old_root != new_root {
    if let Ok(entries) = fs::read_dir(old_root.join("projects")) {
      for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_some_and(|ext| ext == "json") {
          let _ = fs::copy(&path, new_root.join("projects").join(entry.file_name()));
        }
      }
    }
    let tools = old_root.join("custom-tools.json");
    if tools.is_file() {
      let _ = fs::copy(&tools, new_root.join("custom-tools.json"));
    }
  }
  // 3. 授权 fs scope（recursive），使前端可读写该目录（重启后由 setup 恢复）
  app
    .fs_scope()
    .allow_directory(new_root, true)
    .map_err(|e| format!("目录授权失败：{e}"))?;
  // 4. 记录配置
  let cfg_path = app
    .path()
    .app_data_dir()
    .map_err(|e| format!("读取应用数据目录失败：{e}"))?
    .join(DATA_DIR_CFG);
  fs::write(&cfg_path, json!({ "dir": new_dir.trim() }).to_string())
    .map_err(|e| format!("写入配置失败：{e}"))?;
  Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_http::init())
    .setup(|app| {
      // 启动时恢复用户自定义数据目录的 fs scope（配置记录于 appDataDir/data-dir.json）
      if let Ok(cfg_path) = app.path().app_data_dir().map(|d| d.join(DATA_DIR_CFG)) {
        if let Ok(raw) = fs::read_to_string(&cfg_path) {
          if let Ok(cfg) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(dir) = cfg.get("dir").and_then(|v| v.as_str()) {
              let _ = app.fs_scope().allow_directory(dir, true);
            }
          }
        }
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![set_data_dir])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
