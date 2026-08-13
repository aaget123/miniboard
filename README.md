# Miniboard 白板

本地优先的手绘白板应用。桌面端由 Tauri 2 承载，画布使用 leafer-ui 2.2.9 渲染，支持在浏览器中调试运行（功能与桌面端一致）。

## 功能

- **绘图工具**：选择、画笔、直线、箭头、矩形、椭圆、文本
- **选择**：像素级命中（线段/箭头/画笔按实际描边命中）；细线带 5px 命中容差；空心图形透明区域可穿透选中下层元素
- **整理**：只把画笔手绘的弯曲线条拉直（Douglas-Peucker 简化，容差 5px；首尾相近自动识别为闭合图形），其余元素不受影响
- **画布缩放**：自由缩放 10% ~ 800%
  - 滚轮：以鼠标所在位置为中心，向上放大 / 向下缩小
  - 工具栏按钮：`−` 缩小 / `100%` 还原 / `＋` 放大
  - 快捷键：`Ctrl+=` 放大、`Ctrl+-` 缩小、`Ctrl+0` 还原
  - 状态栏实时显示当前百分比
- **撤销 / 重做**：`Ctrl+Z` / `Ctrl+Shift+Z`（或 `Ctrl+Y`）
- **存储**：自动保存（桌面端写入系统应用数据目录，浏览器端写入 localStorage）；打开 / 另存为 JSON 文件；导出 PNG 图片

## 技术栈

| 层 | 技术 |
| --- | --- |
| 桌面壳 | Tauri 2（Rust） |
| 前端构建 | Vite 6 + TypeScript |
| 画布渲染 | leafer-ui 2.2.9 + @leafer-in/editor / arrow / export / text-editor |

## 开发调试

开发阶段推荐直接在浏览器中调试，不需要构建 exe：

```bash
npm install
npm run dev        # 浏览器打开 http://localhost:5173
```

需要验证桌面集成（文件对话框、系统存储等）时再运行桌面开发模式：

```bash
npm run tauri dev
```

## 构建

仅在功能调试完成、需要交付 exe 时执行：

```bash
# Windows（自动注入 MSVC 环境）
powershell -ExecutionPolicy Bypass -File tools/build-tauri.ps1

# 或 Tauri 官方命令
npm run tauri build
```

产物位置：`src-tauri/target/release/`（exe 与 NSIS 安装包）；`release/` 目录为本地留存的便携 exe 副本（不提交到仓库）。

## 项目结构

```
src/
├── main.ts            # 入口：工具栏/状态栏/快捷键接线
├── storage.ts         # 存储层：自动保存/打开/另存/导出 PNG
├── types.ts           # 元素数据结构
├── ui/
│   ├── toolbar.ts     # 工具栏（工具/样式/缩放/文件按钮）
│   └── style.css
└── board/
    ├── canvas.ts      # 画布核心：绘制交互/缩放/序列化
    ├── beautify.ts    # 整理：画笔路径拉直
    ├── history.ts     # 撤销重做
    └── textedit.ts    # 文本输入浮层
```

## 已知说明

- leafer-ui 2.2.9 的 `InteractionBase` 中 move / zoom / wheel 均为空实现，滚轮缩放由 `canvas.ts` 自行实现（直接操作 `tree.zoomLayer`），因此不要依赖 `wheel.zoomMode` 或 `app.zoom()` 配置。
- 元素使用 `fill: undefined` 表示无填充；`fill: "none"` 在该版本会被渲染为黑色实心。
