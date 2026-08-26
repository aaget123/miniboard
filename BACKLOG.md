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

已落地四项（增量画布感知 / 智能对齐参考线 / 框架名称标签 / 落框高亮，详见 CHANGELOG）。剩余：

| 项目 | 设计要点 |
| --- | --- |
| **正交折线连接线** | line 增加 route 类型（L 形路径点集），端点绑定复用 bindStart/bindEnd；重算时机跟随节点移动 |
| **连接器模式** | 选中节点→边缘锚点拖出→落到目标节点自动建绑定箭头（已有端点绑定基础） |
| **AI 增强三件套** | ask_user 澄清工具（中断循环等待用户结构化回答）；draw_flowchart 方向/间距参数；tools.ts 拆 perception/schemas/executors（perception 已部分拆出 ai/perception.ts） |

## P2 · 小尾巴（各项 ≤ 半天）

- [ ] 其余 window.confirm 迁移到应用内弹窗：`ui/confirm.ts` 的 `showConfirm`
      已就绪，设置页/项目管理/工具删除等 7 处仍用原生 confirm
      （WKWebView 环境同样会静默失败）
- [ ] 快照历史 CPU 成本剖析（内存自适应前提不成立，已放弃；如需优化改增量序列化）
- [ ] 小地图升级：Ctrl 概览浮层已有 ✓；常驻迷你小地图 / 滚轮缩放联动视口框待定

## 已知技术债

- canvas.ts 仍约 5500 行：FrameController / PointEditController / 序列化转换层待拆
  （模板参考 crop-controller.ts 的 deps 注入模式）
- settings.ts 约 2000 行单类，建议按页签拆模块
- 橡皮悬停预览在大画布（万级元素）下的 hitTest 成本：必要时做空间索引
- 待查·剪贴板「框架连同内容一起复制」的坐标双移嫌疑：copy() 序列化的是世界坐标，
  粘贴管线却按「相对坐标」契约走 resolveFrameContents → toWorldElement 再加框架
  原点，内容落点疑似偏移（Alt+拖拽复制已通过剥离 frameId 规避该路径）。复现后
  统一 copy/paste 的 frameId 坐标契约
