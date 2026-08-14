# Miniboard 白板

本地优先的手绘白板应用。桌面端由 Tauri 2 承载，画布使用 leafer-ui 2.2.9 渲染，支持在浏览器中调试运行（功能与桌面端一致）。

## 功能

- **绘图工具**：选择、画布移动、框选、套索、画笔、橡皮擦、直线、箭头、矩形、椭圆、文本（工具栏由统一功能注册表驱动，AI 可运行时添加自定义工具）
  - 快捷键：`V` 选择 / `H` 画布移动 / `M` 框选 / `Q` 套索 / `P` 画笔 / `E` 橡皮擦 / `L` 直线 / `A` 箭头 / `R` 矩形 / `O` 椭圆 / `T` 文本 / `K` AI 助手开关
- **AI 助手**（🤖 按钮或 `K` 键，OpenAI 兼容接口，支持流式输出）：
  - **交流模式**：通过 `get_canvas` 感知画布内容（结构化 JSON，含图形形状描述），对话 / 评价 / 给建议；把想法用 `draw_flowchart` 画成流程图写入画布；不擅自改动画布，除非明确要求
  - **编辑模式**：按统一功能规则运行时添加 / 修改 / 删除绘制工具（AI 生成代码函数，立即生效并持久化 localStorage）
  - **@ 选区**：选中图形后点面板 @ 按钮，AI 将重点分析这些元素；明确要求时用 `update_elements` 直接优化（改颜色 / 尺寸 / 位置 / 文字等），整轮改动合并为一步撤销，且只改 @ 选区内元素
  - **设置**：面板齿轮按钮配置接口地址 / API Key / 模型名（localStorage 保存）
- **选择**：像素级命中（线段/箭头/画笔按实际描边命中）；细线带 5px 命中容差；空心图形透明区域可穿透选中下层元素
  - **框选**：拖出矩形选框，选中与其相交的所有元素
  - **套索**：自由圈选闭合区域，选中区域内的元素
  - **选中框内拖动**：在选中元素包围盒内的空白区域按下拖动，可整体移动单个或多个选中元素（悬停显示移动光标）
- **样式编辑**：选中元素后可直接修改描边颜色 / 填充颜色 / 描边粗细
  - 描边与填充双通道独立：点击“描边”/“填充”按钮切换激活通道，色板与自定义取色器作用于当前通道（填充 = 所选色 15% 半透明，填充通道点击自动开启填充）
  - “⬛ 填充”开关：开 = 用记忆的填充色填充，关 = 移除填充；锁定元素与图片不受影响
  - Text 元素：两通道均作用于文字颜色
- **图片插入**：工具栏按钮选择本地图片插入，插入后自动选中，可移动 / 缩放 / 旋转（大图自动缩至视口内）
- **右键菜单**：复制 / 粘贴 / 剪切 / 删除 / 全选 / 置顶 / 置底 / 锁定 / 解锁（锁定后元素不可移动、缩放、删除）
  - 快捷键：`Ctrl+C` 复制 / `Ctrl+X` 剪切 / `Ctrl+V` 粘贴 / `Ctrl+A` 全选
- **整理**：只把画笔手绘的弯曲线条拉直（Douglas-Peucker 简化，容差 5px；首尾相近自动识别为闭合图形），其余元素不受影响
- **画布缩放**：自由缩放 10% ~ 800%
  - 滚轮：以鼠标所在位置为中心，向上放大 / 向下缩小
  - 工具栏按钮：`−` 缩小 / `100%` 还原 / `＋` 放大（还原同时复位画布平移）
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
| AI 助手 | OpenAI 兼容接口（SSE 流式）：浏览器直接 fetch，桌面端经 @tauri-apps/plugin-http 转发 |

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
├── ai/               # AI 助手：双模式对话 / 工具调用 / 设置 / @ 选区
│   ├── panel.ts      # AI 面板（交流/编辑双模式、@ 选区、设置弹窗）
│   ├── client.ts     # OpenAI 兼容客户端（SSE 流式 + 工具调用循环）
│   ├── config.ts     # AI 配置（localStorage）
│   ├── prompts.ts    # 双模式系统提示词
│   ├── tools.ts      # 画布感知 / 形状识别 / 工具执行器
│   └── types.ts
├── main.ts            # 入口：工具栏/状态栏/快捷键/右键菜单接线
├── storage.ts         # 存储层：自动保存/打开/另存/导出 PNG
├── types.ts           # 元素数据结构、工具类型与统一功能规则
├── ui/
│   ├── toolbar.ts     # 工具栏（注册表驱动渲染 + 缩放/文件/AI 按钮）
│   ├── contextmenu.ts # 右键菜单（复制/粘贴/锁定等操作）
│   └── style.css
└── board/
    ├── canvas.ts      # 画布核心：绘制/缩放/选择/橡皮擦/图片/剪贴板/样式应用/序列化
    ├── registry.ts    # 统一功能注册表：内置 + 自定义工具（AI 增删改，localStorage 持久化）
    ├── beautify.ts    # 整理：画笔路径拉直
    ├── history.ts     # 撤销重做
    └── textedit.ts    # 文本输入浮层
```

## 已知说明

- leafer-ui 2.2.9 的 `InteractionBase` 中 move / zoom / wheel 均为空实现，滚轮缩放由 `canvas.ts` 自行实现（直接操作 `tree.zoomLayer`），因此不要依赖 `wheel.zoomMode` 或 `app.zoom()` 配置。
- 元素使用 `fill: undefined` 表示无填充；`fill: "none"` 在该版本会被渲染为黑色实心。
- `@leafer-in/editor` 多选时会向 tree 注入 `SimulateElement`（`skipJSON = true` 的模拟层），业务侧遍历元素时需用该标记过滤（序列化 / 全选 / 框选 / 计数）。
- AI 助手依赖 `@tauri-apps/plugin-http` 实现桌面端网络请求（浏览器端直接 fetch）；开发阶段在浏览器中调试即可。
