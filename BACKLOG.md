# 遗留路线图（Backlog）

按优先级分层的未实施项。每条附关键设计提示，避免重复踩坑。
完成一批请同步更新本文件与 CHANGELOG。

## P0 · 已拍板并落地

原两项决策已于本轮实施（详见 CHANGELOG [Unreleased]）：

1. ~~Alt+拖拽复制 vs Alt 出框豁免冲突~~ → **约束开启的框架内禁用复制**，
   框架外 Alt 用作复制修饰键；Alt 的「拖出豁免」语义不受影响。
2. ~~biome format 是否强制进 CI~~ → **强制**；一次性全量重排已登记
   `.git-blame-ignore-revs`。

## P1 · 大型独立项目（每项 1~3 天，单独开分支）

七项已全部落地（增量画布感知 / 智能对齐参考线 / 框架名称标签 / 落框高亮 /
正交折线连接线 / 连接器模式 / AI 增强三件套，详见 CHANGELOG）。后续延伸候选：

- **正交路由升级**：当前为单拐点 L 形；避障绕行（多段 Z/门形）与多连线
  分层间距可作为增强方向
- **智能对齐参考线**：P1 已落地但按用户反馈调整为「吸附保留、参考线显示
  移除」（迟滞防抖机制仍在）；如需恢复视觉参考线可作为小开关再加回
- **tools.ts 继续拆分**：schemas 已拆出 ai/tool-schemas.ts、perception 纯函数
  已拆出 ai/perception.ts；执行器（executeTool 各 case）仍约 900 行，
  可按 create/update/arrange/beautify 再切

## P2 · 小尾巴

**当前无未实施项。** 已完成的最后一批：

- ~~其余 window.confirm 迁移~~ ✓ 全部 9 处统一走 `ui/confirm.ts` 的 `showConfirm`
  （项目删除 / 工具删除 / AI 配置删除 / 工具栏布局重置 / 快捷键重置与冲突覆盖 /
  提示词重置）
- ~~快照历史 CPU 成本剖析~~ ✓ 分析完成，结论如下：
  - `History` 为引用入栈：push O(1)（redo 分支裁剪的 slice O(深度) 可忽略），
    undo/redo 返回存储引用 O(1)；已补 `history.test.ts`（含 60 步 × 5000 元素规模用例）
  - 真实成本在两处 O(n)：commitHistory → `board.serialize()` 全量序列化
    （250ms 防抖节流）与 undo/redo 后 `loadElements` 全量重建——前者是持续拖动
    的高频路径，后者是每次撤销的一次性成本
  - 决策维持：万级元素出现可感知卡顿前不做增量序列化；届时优化点在
    serializeWorld 层（脏区/版本号），History 结构无需改动
- ~~小地图升级~~ ✓ Ctrl 概览浮层可见期间 rAF 实时刷新（缩放/平移/内容变化
  即时反映视口框）；「常驻迷你小地图」形态暂不做——Ctrl 浮层已覆盖需求，
  如需再加设置开关

## 已知技术债

- ~~canvas.ts 拆分~~ ✓ 五刀完成：PointEditController / FrameController /
  EraserController / scene-format（序列化转换层）/ AiOpsController（AI 编排）
  已拆出，canvas.ts 6214→3727 行（事件管线/绘制管线/样式/选择剪贴板/历史编排
  保留）；剩余候选：settings.ts 按页签拆模块（见 ARCHITECTURE.md）
- settings.ts 约 2000 行单类，建议按页签拆模块
- ~~橡皮悬停预览在大画布（万级元素）下的 hitTest 成本~~ ✓ 空间网格索引已落地
  （spatial-grid.ts；脏标记由 property.change / child 事件全局冒泡 + loadElements
  显式打标，空点命中微秒级）。剩余增量：橡皮分段擦除的「纯几何线段距离扫描」
  仍按全量 Line 遍历（纯数字运算快、实测 ~1ms@1万），如需再优化可在同一索引上
  按 Line 子集预筛
- E2E 回归已固化（npm run test:e2e，本地 dev server 前置）；如需进 CI 需在
  runner 里起 dev server + 安装 Playwright（成本可控，待定）
- 待查·剪贴板「框架连同内容一起复制」的坐标双移嫌疑：copy() 序列化的是世界坐标，
  粘贴管线却按「相对坐标」契约走 resolveFrameContents → toWorldElement 再加框架
  原点，内容落点疑似偏移（Alt+拖拽复制已通过剥离 frameId 规避该路径）。复现后
  统一 copy/paste 的 frameId 坐标契约
