# 贡献指南

感谢你对 Miniboard 的兴趣！无论是修 bug、加功能、改进文档还是提建议，都欢迎。

## 开发环境

- [Node.js](https://nodejs.org/) ≥ 18
- [Rust](https://www.rust-lang.org/tools/install)（构建桌面版需要）
- Windows 构建桌面版还需 [MSVC 工具链与 Windows SDK](https://learn.microsoft.com/zh-cn/windows/msvc/building-on-the-command-line)

## 本地运行

```bash
npm install
npm run dev        # 浏览器调试（功能与桌面端一致，开发首选）
npm run tauri dev  # 桌面开发模式（验证文件对话框/系统存储等集成）
```

> 国内网络安装依赖较慢时，可编辑项目根目录 `.npmrc`，取消 `registry=https://registry.npmmirror.com` 一行的注释启用镜像。

## 测试与检查

```bash
npm test           # 单元测试（vitest）
npm run build      # 类型检查 + 前端构建（vite build 内含 tsc 检查）
```

- 修改核心纯函数（坐标换算 / 形状识别 / 粘贴平移 / 工具注册表等）时**必须补充或更新对应的 `*.test.ts` 单元测试**
- 提交前确保 `npm test` 全部通过

## 代码规范

- **分层约束**：`board/`（画布内核）与 `storage.ts` 不依赖 `ui/`；`ui/` 通过回调/依赖注入与内核通信，保持平台耦合解耦
- **桌面/浏览器双环境**：涉及存储、对话框、网络的能力，按 `isDesktop()` 分流（桌面走 Tauri API，浏览器回退 localStorage / 原生控件），新增能力需同时覆盖两端
- **中文注释**：注释与提交信息使用中文；公开 API（导出函数/类/接口）必须有 JSDoc 说明
- 功能开关与偏好使用 localStorage（键名 `miniboard:` 前缀）；数据文件写入数据目录（见 README「数据存储」）

## 提交与 PR

1. `git checkout -b feature/你的改动`
2. 提交信息遵循中文规范，格式：`类型: 简述`（类型如 `fix` / `feat` / `docs` / `refactor` / `test`），例如：
   - `fix: 修复项目重命名后列表不刷新`
   - `feat: 支持自定义数据存储目录`
3. 推送分支并提交 PR，描述改动内容与验证方式
4. 保持每个 PR 聚焦单一改动；大型重构请先开 Issue 讨论

## 提 Issue

- **Bug**：使用 bug 模板，附上复现步骤、期望/实际行为、运行环境（浏览器或桌面版、系统版本）
- **功能建议**：使用 feature 模板，说明使用场景与期望效果
