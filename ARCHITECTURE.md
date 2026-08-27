# 架构说明

面向贡献者的设计文档：解释分层决策与两条最容易踩坑的"祖传陷阱"。
功能清单见 [README](./README.md)，变更记录见 [CHANGELOG](./CHANGELOG.md)。

## 分层总览

```
┌─ Rust 壳层 src-tauri（刻意做薄）───────────────────────┐
│ 仅 set_data_dir 一个命令 + dialog/fs/http 官方插件；      │
│ 原则：能在 Web 层实现的绝不进 Rust，保证浏览器调试等价     │
├─ 组合根 main.ts ────────────────────────────────────┤
│ 接线全部 UI 组件回调、快捷键分发、懒加载工厂（AI 面板）     │
├─ board/ 画布核心域 ─────────────────────────────────┤
│ canvas.ts = Board 门面（绘制管线/编辑器事件接线）          │
│ CropController 等控制器：独立交互特性，经 deps 对象解耦    │
│ geometry/element-utils/frame/stroke/rough… 纯函数层      │
│ registry.ts：统一工具注册表（内置工具 = AI 自定义工具同管线）│
├─ ai/ AI 助手（懒加载分块）────────────────────────────┤
│ panel(双模式 UI) / client(SSE) / tools(感知+执行器)       │
├─ ui/ 表现层 ────────────────────────────────────────┤
│ toolbar/settings/selectionbar/statusbar/contextmenu…    │
└─ storage-core.ts 存储契约纯函数 ←→ storage.ts I/O 适配 ──┘
```

**依赖方向**：`main → 各域 → 纯函数层`。纯函数层（storage-core / geometry /
element-utils / frame / coords / offset / arrange…）不依赖 leafer 与 DOM，
全部配 vitest 单元测试；Board 及 UI 层暂无集成测试（见"测试策略"）。

## 陷阱一：page / world 双坐标基准

leafer 的坐标系有两套基准，混用是本项目历史上最多 bug 的来源
（约束失效、粘贴错位、点编辑漂移均源于此）：

| 基准 | 获取方式 | 含义 |
| --- | --- | --- |
| **page** | `tree.getInnerPoint(...)`、`el.getBounds("box", "page")` | tree 局部坐标，**不含 zoomLayer 变换**，画布缩放/平移后数值不变 |
| **world** | 指针 `e.x/e.y`、`el.worldBoxBounds` | 视口基准，随 zoomLayer 缩放/平移变化 |

规则：

1. **绘制、约束夹紧、粘贴落点**统一用 page 基准（用户感知的"画布坐标"）；
2. **跨元素几何、sky 层手柄摆放、AI 感知输出**用 world，且局部↔世界换算必须走
   `getWorldPoint / getLocalPoint / getWorldPointByLocal`，禁止手写矩阵；
3. 新代码涉及坐标时先问一句："这个数是哪个基准？"——注释里也请标明。

## 陷阱二：契约元素的坐标约定

line / arrow / path（非 freehand）的数据契约是：
**points/path 存画布绝对坐标，元素 x/y 恒为 0**。
但 leafer 编辑器拖动改的是 x/y——因此拖动结束必须调用
`normalizeContractEl(el)` 把位移并入 points/path 并归零（见 DragEvent.END 统一处理）。
绕过该约定的直接改 x/y 都会造成"双重偏移"。freehand 笔迹例外：
x/y 是锚点、path 是局部轮廓、采样点在 `__freehandPoints`。

其余关键序列化契约：

- `ElementData.id`：稳定 id，AI 按 id 引用元素；序列化时自动分配
- `frameId`：内容归属框架的元素存**相对框架原点的坐标**
  （contractFrameContents / expandFrameContents 负责世界⇄相对换算）
- `rough.seed`：手绘抖动种子，保证撤销/重载后形态可复现
- 历史：快照式（60 步全量），一次手势 = 一步撤销

## 工具体系：Registry 统一管线

内置工具与 AI 运行时生成的自定义工具共用同一注册表（toolbar 渲染、快捷键、
绘制分发均以此为准）。AI 生成的生成器代码需通过冒烟测试才会生效：
危险代码扫描 → 隔离 Worker 执行 + 超时熔断 → 返回值格式强校验。

## 存储层

- 多项目 = `projects/index.json` + 每项目场景文件；桌面写数据目录
  （可自定义，Rust set_data_dir 迁移），浏览器回退 localStorage
- **原子写入**：tmp → 旧版本滚动为 bak.1..5 → tmp 原子重命名主文件；
  载入按 主文件 → bak.1..N 回退
- **多开竞争防护**：写入前 stat 主文件 mtime 与本地基线比对，
  不一致即拒绝覆盖并提示（判定纯函数 `detectExternalModification` 可测）
- 解析校验在 storage-core（坏条目丢弃保留其余、激活项目回退），
  ProjectStore 只做 I/O 编排

## 控制器拆分现状

Board 曾是 5000+ 行的上帝类，按"门面 API 不变"原则逐刀拆分：

- ✅ CropController（图片裁剪）
- ✅ 纯函数下沉：geometry / element-utils / frame 坐标契约
- ✅ PointEditController（线性元素点编辑：sky 层手柄/拖点/加点/端点吸附绑定）
- ✅ FrameController（框架域：归属注册表 __frameId、内容移动/旋转/幂等快照
  缩放跟随、⇄矩形互转、折叠/滚动/聚焦、内容约束夹紧）
- ✅ scene-format（序列化转换层：ElementData ⇄ leafer 元素双向纯映射 +
  草稿增量应用；elementToData 经 ElementToDataContext 注入三个无状态回调）
- ✅ SpatialGrid（空间网格索引：命中类查询 O(候选数)；脏标记靠 tree 层
  property.change / child.add / remove 全局冒泡 + loadElements 显式打标）
- ⏳ 后续候选：橡皮擦控制器（分段擦除/待删预览）、AI 排列/整理编排

canvas.ts 现约 4400 行，保留：事件管线（onDown/onMove/onUp/编辑器事件接线）、
绘制统一管线、样式应用、选择/剪贴板/历史编排。

新交互特性的模板参考 `crop-controller.ts`：deps 对象注入 Board 能力，
事件管线经控制器短路分发。

## 测试策略

- 纯函数层 vitest 全覆盖（坐标/分段擦除/排列/解析/契约往返/空间索引模糊对照……）
- **E2E 回归**：`npm run test:e2e`（tests/e2e/board-regress.cjs，Playwright +
  Edge 驱动真实交互）覆盖 多选整组拖动 / 框架转换与内容跟随 / 点编辑端点拖动 /
  橡皮擦除 / 撤销恢复 / serialize 往返幂等——需本地 dev server (5173) 在跑
- CI（test.yml）：前端 lint + vitest + vite build；rust-check job 跑
  `cargo check` 守住桌面端编译
